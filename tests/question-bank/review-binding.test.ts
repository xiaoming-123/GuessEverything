/**
 * P1 审核版本绑定测试
 *
 * 核心不变式：ReviewRecord.inputHash === 被审核版本的 contentHash。
 * - 审核通过后修改版本（contentHash 变化）→ 旧 PASS 审核不再命中 → 发布阻断。
 * - 修订创建新版本 → 新版本必须重新走 校验+审核，不能沿用旧批准。
 * - 修订轮次上限（maxRevisionRounds）→ 仍失败则 QUARANTINED（待核验）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { QuestionBankDb } from "@/lib/question-bank/infra/question-bank-db";
import { ReviewPipeline } from "@/lib/question-bank/pipeline/review";
import { SimulatedProvider } from "@/lib/question-bank/providers/simulated";
import { buildSnapshot } from "@/lib/question-bank/sources/evidence";
import { questionContentHash } from "@/lib/question-bank/validators/rules";
import type {
  QuestionVersion,
  SourceEntry,
  Work,
  WorkVersion,
} from "@/lib/question-bank/contracts/types";

const SOURCE: SourceEntry = {
  sourceId: "src-x",
  type: "LOCAL_CORPUS",
  uri: "local://corpus",
  license: "公版",
  versionStrategy: "CONTENT_HASH",
  allowedUse: ["PRIMARY_TEXT"],
  enabled: true,
};

function fixture(workVersionId = "wv-1") {
  const rawText =
    "春晓\n孟浩然\n春眠不觉晓，处处闻啼鸟。\n夜来风雨声，花落知多少。";
  const snapshot = buildSnapshot({
    snapshotId: "snap-1",
    sourceId: "src-x",
    revision: "r1",
    capturedAt: "2026-09-18T00:00:00.000Z",
    evidencePath: "corpus/孟浩然/春晓.txt",
    rawText,
  });
  const work: Work = {
    workId: "work-chunxiao",
    authorCanonical: "孟浩然",
    titleCanonical: "春晓",
    dynasty: "唐",
    verificationStatus: "VERIFIED",
    authorAliases: [],
    titleAliases: [],
    currentVersionId: workVersionId,
  };
  const workVersion: WorkVersion = {
    workVersionId,
    workId: "work-chunxiao",
    version: 1,
    title: "春晓",
    author: "孟浩然",
    lines: ["春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少"],
    contentHash: snapshot.contentHash,
    evidence: [],
  };
  return { source: SOURCE, snapshot, work, workVersion };
}

function makeGuessPoetVersion(
  workVersionId: string,
  options: [string, string, string, string],
  correctOptionId: string,
  version = 1,
  revisionRound = 0,
): QuestionVersion {
  const v: QuestionVersion = {
    questionId: "q-chunxiao-poet",
    version,
    type: "GUESS_POET",
    prompt: "春眠不觉晓",
    options,
    correctOptionId,
    evidence: {
      promptSpan: { snapshotId: "snap-1", start: rawIndexOf("春眠不觉晓"), end: rawIndexOf("春眠不觉晓") + 5 },
      answerSpan: { snapshotId: "snap-1", start: rawIndexOf("孟浩然"), end: rawIndexOf("孟浩然") + 3 },
    },
    workVersionId,
    contentHash: "",
    status: "DRAFT",
    revisionRound,
  };
  v.contentHash = questionContentHash(v);
  return v;
}

function rawIndexOf(s: string): number {
  const rawText =
    "春晓\n孟浩然\n春眠不觉晓，处处闻啼鸟。\n夜来风雨声，花落知多少。";
  return rawText.indexOf(s);
}

let db: QuestionBankDb;
const now = () => "2026-09-18T00:00:00.000Z";

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

describe("审核版本绑定", () => {
  it("审核通过 → 发布哈希与审核哈希一致（getLatestPassReview 命中）", async () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const f = fixture();
    db.upsertSource(f.source);
    db.saveSnapshot(f.snapshot);
    db.saveWorkVersion(f.workVersion);
    db.upsertWork(f.work);

    const v1 = makeGuessPoetVersion(
      "wv-1",
      ["孟浩然", "李白", "杜甫", "王维"],
      "孟浩然",
    );
    const pipeline = new ReviewPipeline({
      db,
      provider: new SimulatedProvider(),
      nowIso: now,
    });
    const outcome = await pipeline.run(
      { version: v1, distractorPool: ["李白", "杜甫", "王维", "白居易"] },
      f,
    );
    expect(outcome.approved).toBe(true);
    expect(outcome.finalStatus).toBe("APPROVED");
    expect(outcome.finalVersion).toBe(1);

    const review = db.getLatestPassReview("q-chunxiao-poet", 1);
    expect(review).toBeTruthy();
    expect(review!.inputHash).toBe(v1.contentHash); // 审核哈希 = 发布哈希
  });

  it("审核 inputHash 与版本 contentHash 不一致 → 该审核不视为通过（绑定守卫）", () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const f = fixture();
    db.upsertSource(f.source);
    db.saveSnapshot(f.snapshot);
    db.saveWorkVersion(f.workVersion);
    db.upsertWork(f.work);

    const v1 = makeGuessPoetVersion(
      "wv-1",
      ["孟浩然", "李白", "杜甫", "王维"],
      "孟浩然",
    );
    db.saveQuestionVersion(v1);
    db.transitionQuestionVersion("q-chunxiao-poet", 1, "VALIDATING", v1.contentHash);
    db.transitionQuestionVersion("q-chunxiao-poet", 1, "REVIEWING", v1.contentHash);

    // 错误绑定的审核（inputHash ≠ 版本 contentHash）→ 不命中
    db.saveReview({
      reviewId: "r-wrong",
      questionId: "q-chunxiao-poet",
      questionVersion: 1,
      inputHash: "0".repeat(64),
      role: "INDEPENDENT_REVIEWER",
      modelVersion: "SIMULATED",
      independentAnswer: "孟浩然",
      issues: [],
      verdict: "PASS",
      createdAt: now(),
    });
    expect(db.getLatestPassReview("q-chunxiao-poet", 1)).toBeNull();

    // 正确绑定的审核（inputHash = 版本 contentHash）→ 命中
    db.saveReview({
      reviewId: "r-right",
      questionId: "q-chunxiao-poet",
      questionVersion: 1,
      inputHash: v1.contentHash,
      role: "INDEPENDENT_REVIEWER",
      modelVersion: "SIMULATED",
      independentAnswer: "孟浩然",
      issues: [],
      verdict: "PASS",
      createdAt: now(),
    });
    const hit = db.getLatestPassReview("q-chunxiao-poet", 1);
    expect(hit).toBeTruthy();
    expect(hit!.reviewId).toBe("r-right");
    expect(hit!.inputHash).toBe(v1.contentHash);
  });

  it("发布清单对「审核后修改」的题拒绝：contentHash 与审核哈希不一致 → 验收失败", async () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const f = fixture();
    db.upsertSource(f.source);
    db.saveSnapshot(f.snapshot);
    db.saveWorkVersion(f.workVersion);
    db.upsertWork(f.work);

    const v1 = makeGuessPoetVersion(
      "wv-1",
      ["孟浩然", "李白", "杜甫", "王维"],
      "孟浩然",
    );
    const pipeline = new ReviewPipeline({
      db,
      provider: new SimulatedProvider(),
      nowIso: now,
    });
    const outcome = await pipeline.run(
      { version: v1, distractorPool: ["李白", "杜甫", "王维", "白居易"] },
      f,
    );
    expect(outcome.approved).toBe(true);

    // 发布：此时审核哈希与发布哈希一致 → 通过
    const { buildManifest } = await import("@/lib/question-bank/pipeline/publisher");
    const ok1 = buildManifest(db, "bk1", "rel-t1", "b-t1", now());
    expect(ok1.acceptance.ok).toBe(true);
    expect(ok1.items).toHaveLength(1);
    expect(ok1.items[0].reviewInputHash).toBe(ok1.items[0].contentHash);

    // 模拟"审核后修改"：新版本 v2（内容变化）未重新审核 → 清单拒绝
    const v2: QuestionVersion = {
      ...v1,
      version: 2,
      options: ["孟浩然", "李白", "杜甫", "韩愈"],
      contentHash: "",
      status: "APPROVED",
    };
    v2.contentHash = questionContentHash(v2);
    db.saveQuestionVersion(v2); // v2 无审核记录
    const ok2 = buildManifest(db, "bk2", "rel-t2", "b-t1", now());
    const qidIssues = ok2.acceptance.issues.filter(
      (i) => i.location?.includes("q-chunxiao-poet#v2"),
    );
    expect(qidIssues.length).toBe(1);
    expect(qidIssues[0].code).toBe("NO_PASS_REVIEW");
    expect(ok2.acceptance.ok).toBe(false);
  });

  it("修订创建新版本 → 新版本独立审核（不能沿用 v1 的 PASS）", async () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const f = fixture();
    db.upsertSource(f.source);
    db.saveSnapshot(f.snapshot);
    db.saveWorkVersion(f.workVersion);
    db.upsertWork(f.work);

    // v1：选项重复（DUPLICATE_OPTION）→ 触发修订
    const v1 = makeGuessPoetVersion(
      "wv-1",
      ["孟浩然", "孟浩然", "杜甫", "王维"],
      "孟浩然",
      1,
      0,
    );
    const pipeline = new ReviewPipeline({
      db,
      provider: new SimulatedProvider(),
      nowIso: now,
    });
    const outcome = await pipeline.run(
      { version: v1, distractorPool: ["李白", "杜甫", "王维", "白居易"] },
      f,
    );
    expect(outcome.approved).toBe(true);
    expect(outcome.finalVersion).toBe(2); // 修订产生 v2
    expect(outcome.roundsUsed).toBe(1);
    // v1 被标记 NEEDS_REVISION
    expect(db.getQuestionVersion("q-chunxiao-poet", 1)!.status).toBe("NEEDS_REVISION");
    // v2 APPROVED 且有独立 PASS 审核
    expect(db.getQuestionVersion("q-chunxiao-poet", 2)!.status).toBe("APPROVED");
    const review2 = db.getLatestPassReview("q-chunxiao-poet", 2);
    expect(review2).toBeTruthy();
    // v2 的审核 inputHash 绑定 v2 的 contentHash（不是 v1）
    const v2 = db.getQuestionVersion("q-chunxiao-poet", 2)!;
    expect(review2!.inputHash).toBe(v2.contentHash);
    expect(review2!.inputHash).not.toBe(v1.contentHash);
  });

  it("修订轮次上限：不可修复的错误 → QUARANTINED（待核验），不无限修订", async () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const f = fixture();
    db.upsertSource(f.source);
    db.saveSnapshot(f.snapshot);
    db.saveWorkVersion(f.workVersion);
    db.upsertWork(f.work);

    // 答案泄漏（题干含作者名）→ QUARANTINE，不可自动修订
    const leaky = makeGuessPoetVersion(
      "wv-1",
      ["孟浩然", "李白", "杜甫", "王维"],
      "孟浩然",
    );
    leaky.prompt = "孟浩然写的诗：春眠不觉晓";
    leaky.evidence.promptSpan = {
      snapshotId: "snap-1",
      start: 0,
      end: 5,
    };
    leaky.contentHash = questionContentHash(leaky);

    const pipeline = new ReviewPipeline({
      db,
      provider: new SimulatedProvider(),
      rules: { maxRevisionRounds: 2 },
      nowIso: now,
    });
    const outcome = await pipeline.run(
      { version: leaky, distractorPool: ["李白", "杜甫", "王维", "白居易"] },
      f,
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.finalStatus).toBe("QUARANTINED");
    expect(outcome.termination).toBe("QUARANTINED");
  });
});
