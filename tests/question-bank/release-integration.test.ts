/**
 * P1 发布层集成测试（临时 SQLite 库）
 *
 * 覆盖：
 * - 幂等入库（同 batchKey 重复发布 → 同一清单，不产生第二份）
 * - 不可变发布（清单哈希/条目在重复发布后不变）
 * - 原子激活（compare-and-swap：旧指针不匹配 → 拒绝）
 * - 回滚（切回先前清单；审计记录 ROLLBACK）
 * - 验收门控（验收未通过 → 不写清单，记 REJECTED 审计）
 * - 审核哈希 ≠ 发布哈希 → 验收失败
 */

import { afterEach, describe, expect, it } from "vitest";
import { QuestionBankDb } from "@/lib/question-bank/infra/question-bank-db";
import {
  buildManifest,
  publishBatch,
} from "@/lib/question-bank/pipeline/publisher";
import type {
  QuestionVersion,
  SourceEntry,
  Work,
  WorkVersion,
} from "@/lib/question-bank/contracts/types";
import { buildSnapshot } from "@/lib/question-bank/sources/evidence";
import { questionContentHash } from "@/lib/question-bank/validators/rules";

const T0 = "2026-09-18T00:00:00.000Z";
const T1 = "2026-09-18T01:00:00.000Z";
const T2 = "2026-09-18T02:00:00.000Z";

let db: QuestionBankDb;

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

/** 装配一道 APPROVED 候选题（含通过审核记录） */
function seedApprovedQuestion(
  qid: string,
  options: [string, string, string, string],
  correctOptionId: string,
  hashSuffix: string,
): QuestionVersion {
  const rawText = `题${qid}\n作者甲\n春眠不觉晓，处处闻啼鸟。\n夜来风雨声，花落知多少。`;
  const snapshot = buildSnapshot({
    snapshotId: `snap-${qid}`,
    sourceId: "src-x",
    revision: `r-${hashSuffix}`,
    capturedAt: T0,
    evidencePath: `corpus/${qid}.txt`,
    rawText,
  });
  const source: SourceEntry = {
    sourceId: "src-x",
    type: "LOCAL_CORPUS",
    uri: "local://corpus",
    license: "公版",
    versionStrategy: "CONTENT_HASH",
    allowedUse: ["PRIMARY_TEXT"],
    enabled: true,
  };
  const work: Work = {
    workId: `work-${qid}`,
    authorCanonical: "作者甲",
    titleCanonical: `题${qid}`,
    dynasty: "唐",
    verificationStatus: "VERIFIED",
    authorAliases: [],
    titleAliases: [],
    currentVersionId: `wv-${qid}`,
  };
  const workVersion: WorkVersion = {
    workVersionId: `wv-${qid}`,
    workId: work.workId,
    version: 1,
    title: work.titleCanonical,
    author: work.authorCanonical,
    lines: ["春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少"],
    contentHash: snapshot.contentHash,
    evidence: [],
  };
  db.upsertSource(source);
  db.saveSnapshot(snapshot);
  db.saveWorkVersion(workVersion);
  db.upsertWork(work);

  const v: QuestionVersion = {
    questionId: qid,
    version: 1,
    type: "GUESS_POET",
    prompt: "春眠不觉晓",
    options,
    correctOptionId,
    evidence: {
      promptSpan: { snapshotId: snapshot.snapshotId, start: rawText.indexOf("春眠不觉晓"), end: rawText.indexOf("春眠不觉晓") + 5 },
      answerSpan: { snapshotId: snapshot.snapshotId, start: rawText.indexOf("作者甲"), end: rawText.indexOf("作者甲") + 3 },
    },
    workVersionId: workVersion.workVersionId,
    contentHash: "",
    status: "APPROVED",
  };
  v.contentHash = questionContentHash(v);
  db.saveQuestionVersion(v);
  // 通过审核（inputHash 绑定 contentHash）
  db.saveReview({
    reviewId: `rev-${qid}`,
    questionId: qid,
    questionVersion: 1,
    inputHash: v.contentHash,
    role: "INDEPENDENT_REVIEWER",
    modelVersion: "SIMULATED",
    independentAnswer: correctOptionId,
    issues: [],
    verdict: "PASS",
    createdAt: T0,
  });
  return v;
}

describe("发布层：幂等与不可变", () => {
  it("相同批次重复发布 → 幂等返回既有清单，不产生第二份发布", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    db.upsertBatch("b1", 10_000);
    seedApprovedQuestion("q1", ["作者甲", "乙", "丙", "丁"], "作者甲", "a");

    const r1 = publishBatch(db, {
      batchId: "b1", batchKey: "bk1", releaseId: "rel-1", createdAt: T0,
      activate: true,
    });
    expect(r1.ok).toBe(true);
    expect(r1.itemCount).toBe(1);
    expect(r1.activated).toBe(true);
    expect(r1.idempotent).toBe(false);

    const rel1 = db.getRelease(r1.releaseId!)!;
    const hash1 = rel1.manifestHash;
    const items1 = JSON.stringify(rel1.items);

    // 重复发布（同 batchKey，不同 releaseId）→ 幂等
    const r2 = publishBatch(db, {
      batchId: "b1", batchKey: "bk1", releaseId: "rel-2", createdAt: T1,
      activate: false,
    });
    expect(r2.ok).toBe(true);
    expect(r2.idempotent).toBe(true);
    expect(r2.releaseId).toBe(r1.releaseId); // 同一份清单

    const relAgain = db.getRelease(r1.releaseId!)!;
    expect(relAgain.manifestHash).toBe(hash1); // 不可变
    expect(JSON.stringify(relAgain.items)).toBe(items1); // 条目不变

    // 审计只有一份 CREATED
    const audit = db.releaseAudit(r1.releaseId!);
    expect(audit.filter((a) => a.action === "CREATED")).toHaveLength(1);
  });

  it("清单哈希对条目顺序/内容敏感", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    db.upsertBatch("b1", 10_000);
    seedApprovedQuestion("q1", ["作者甲", "乙", "丙", "丁"], "作者甲", "a");
    seedApprovedQuestion("q2", ["作者甲", "乙", "丙", "丁"], "作者甲", "b");

    const m1 = buildManifest(db, "bk1", "rel-1", "b1", T0);
    const m2 = buildManifest(db, "bk2", "rel-2", "b1", T0);
    expect(m1.manifestHash).not.toBe(m2.manifestHash); // batchKey 不同 → 哈希不同
    expect(m1.items).toHaveLength(2);
  });
});

describe("发布层：原子激活与回滚", () => {
  it("原子激活：旧指针不匹配 → 拒绝（防并发覆盖）", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    db.upsertBatch("b1", 10_000);
    seedApprovedQuestion("q1", ["作者甲", "乙", "丙", "丁"], "作者甲", "a");
    seedApprovedQuestion("q2", ["作者甲", "乙", "丙", "丁"], "作者甲", "b");

    const r1 = publishBatch(db, {
      batchId: "b1", batchKey: "bk1", releaseId: "rel-A", createdAt: T0, activate: true,
    });
    expect(r1.ok).toBe(true);
    expect(db.getActiveRelease()!.releaseId).toBe("rel-A");

    // 先创建第二份清单 rel-B（不同 batchKey），供后续指针切换验证
    const mB = buildManifest(db, "bk2", "rel-B", "b1", T1);
    const stB = db.upsertRelease({
      releaseId: "rel-B", batchId: "b1", batchKey: "bk2",
      ruleVersion: mB.ruleVersion, items: mB.items, manifestHash: mB.manifestHash,
      acceptance: { ok: mB.acceptance.ok, issues: mB.acceptance.issues.map((i) => i.code) },
      createdAt: T1,
    });
    expect("releaseId" in stB).toBe(true);

    // 用过期指针（null）尝试激活 rel-B → 拒绝
    const bad = db.activateRelease("rel-B", null, T1);
    expect(bad.ok).toBe(false);
    expect(db.getActiveRelease()!.releaseId).toBe("rel-A"); // 指针未变

    // 用正确指针激活 rel-B
    const good = db.activateRelease("rel-B", "rel-A", T1);
    expect(good.ok).toBe(true);
    expect(db.getActiveRelease()!.releaseId).toBe("rel-B");
    expect(db.getActiveRelease()!.previousReleaseId).toBe("rel-A");
  });

  it("回滚：切回先前清单，审计含 ROLLBACK；清单本身保留（不删除）", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    db.upsertBatch("b1", 10_000);
    seedApprovedQuestion("q1", ["作者甲", "乙", "丙", "丁"], "作者甲", "a");

    publishBatch(db, {
      batchId: "b1", batchKey: "bk1", releaseId: "rel-A", createdAt: T0, activate: true,
    });
    // 再发布一版（同批次幂等 → 仍是 rel-A；改用新 batchKey 造第二份清单）
    db.upsertBatch("b2", 10_000);
    const rB = publishBatch(db, {
      batchId: "b2", batchKey: "bk2", releaseId: "rel-B", createdAt: T1, activate: true,
    });
    expect(rB.ok).toBe(true);
    expect(db.getActiveRelease()!.releaseId).toBe("rel-B");

    // 回滚到 rel-A
    const current = db.getActiveRelease()!.releaseId;
    const rb = db.rollbackRelease(current, "rel-A", T2);
    expect(rb.ok).toBe(true);
    expect(db.getActiveRelease()!.releaseId).toBe("rel-A");

    // 两份清单都还在（不可变、不删除）
    expect(db.getRelease("rel-A")).toBeTruthy();
    expect(db.getRelease("rel-B")).toBeTruthy();

    // 审计：rel-A 有 ACTIVATED（首次）与 ROLLBACK（回滚时记录在目标清单上）
    const auditA = db.releaseAudit("rel-A");
    expect(auditA.some((a) => a.action === "ACTIVATED")).toBe(true);
    expect(auditA.some((a) => a.action === "ROLLBACK")).toBe(true);
  });

  it("回滚目标与当前指针相同 → 拒绝；目标不存在 → 拒绝", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    db.upsertBatch("b1", 10_000);
    seedApprovedQuestion("q1", ["作者甲", "乙", "丙", "丁"], "作者甲", "a");
    publishBatch(db, {
      batchId: "b1", batchKey: "bk1", releaseId: "rel-A", createdAt: T0, activate: true,
    });
    expect(db.rollbackRelease("rel-A", "rel-A", T1).ok).toBe(false);
    expect(db.rollbackRelease("rel-A", "nonexistent", T1).ok).toBe(false);
    expect(db.getActiveRelease()!.releaseId).toBe("rel-A");
  });

  it("回滚至 null（清空激活指针）→ 当前无激活清单", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    db.upsertBatch("b1", 10_000);
    seedApprovedQuestion("q1", ["作者甲", "乙", "丙", "丁"], "作者甲", "a");
    publishBatch(db, {
      batchId: "b1", batchKey: "bk1", releaseId: "rel-A", createdAt: T0, activate: true,
    });
    const rb = db.rollbackRelease("rel-A", null, T1);
    expect(rb.ok).toBe(true);
    expect(db.getActiveRelease()).toBeNull();
  });
});

describe("发布层：验收门控", () => {
  it("验收未通过 → 不写清单，记 REJECTED 审计", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    db.upsertBatch("b1", 10_000);
    seedApprovedQuestion("q1", ["作者甲", "乙", "丙", "丁"], "作者甲", "a");
    // 一道 APPROVED 但审核 inputHash 不一致的题（审核后修改）
    const v2 = seedApprovedQuestion("q2", ["作者甲", "乙", "丙", "丁"], "作者甲", "b");
    // 用直接 SQL 改写 q2 的 contentHash（模拟"审核通过后修改版本"）
    db.transitionQuestionVersion("q2", 1, "VALIDATING", v2.contentHash);
    // 造一个 contentHash 与审核 inputHash 不一致的版本
    const tampered: QuestionVersion = {
      ...v2,
      options: ["作者甲", "乙", "丙", "戊"],
      contentHash: "",
    };
    tampered.contentHash = questionContentHash(tampered);
    // VALIDATING → APPROVED 需先回退：直接用新哈希写新版本 v2（不同 version 号）
    const v3: QuestionVersion = {
      ...tampered,
      version: 2,
      status: "APPROVED",
    };
    db.saveQuestionVersion(v3);

    const res = db.upsertRelease({
      releaseId: "rel-bad",
      batchId: "b1",
      batchKey: "bk-bad",
      ruleVersion: "publish-v1",
      items: [],
      manifestHash: "f".repeat(64),
      acceptance: { ok: false, issues: ["REVIEW_INPUT_HASH_MISMATCH"] },
      createdAt: T0,
    });
    expect("ok" in res && res.ok).toBe(false);
    expect(db.getReleaseByBatchKey("bk-bad")).toBeNull();
    const audit = db.releaseAudit("rel-bad");
    expect(audit.some((a) => a.action === "REJECTED")).toBe(true);
  });

  it("审核哈希 ≠ 发布哈希 → buildManifest 验收失败（NO_PASS_REVIEW / 哈希不一致）", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    db.upsertBatch("b1", 10_000);
    seedApprovedQuestion("q1", ["作者甲", "乙", "丙", "丁"], "作者甲", "a");

    // q1 审核通过。现在把 q1 升到 v2（内容变化，未重新审核）→ 清单拒绝 v2
    const v1 = db.getQuestionVersion("q1", 1)!;
    const v2: QuestionVersion = {
      ...v1,
      version: 2,
      options: ["作者甲", "乙", "丙", "戊"],
      contentHash: "",
      status: "APPROVED",
    };
    v2.contentHash = questionContentHash(v2);
    db.saveQuestionVersion(v2);

    const m = buildManifest(db, "bk1", "rel-1", "b1", T0);
    const issues = m.acceptance.issues;
    expect(m.acceptance.ok).toBe(false);
    // v1 正常入清单，v2 被拒绝（无与其哈希一致的审核）
    expect(m.items.map((i) => i.questionVersion)).toContain(1);
    expect(issues.some((i) => i.location?.includes("q1#v2"))).toBe(true);
  });
});
