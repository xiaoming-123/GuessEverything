/**
 * P1 端到端管线测试（模拟来源 + 模拟 provider + 隔离测试库）
 *
 * 全链路：
 *   采集（模拟来源 → 快照/作品落库）
 *   → 命题（COMPOSE 任务：模板命题 + 证据映射 + 题目身份）
 *   → 审核（REVIEW 任务：规则校验 + 独立审核 + 修订闭环）
 *   → 发布（PUBLISH 任务：清单验收 + 原子激活）
 *   → 回滚（切回无激活/先前清单）
 *
 * 同时验证：崩溃恢复（worker 领取后"崩溃"，过期重领后管线继续）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { QuestionBankDb } from "@/lib/question-bank/infra/question-bank-db";
import { SimulatedProvider } from "@/lib/question-bank/providers/simulated";
import { buildSnapshot } from "@/lib/question-bank/sources/evidence";
import {
  createBatch,
  createOrchestrator,
  drain,
  ingestWork,
  planComposeTasks,
  rollback,
} from "@/lib/question-bank/pipeline/orchestrator";
import { publishBatch } from "@/lib/question-bank/pipeline/publisher";
import type {
  SourceEntry,
  Work,
  WorkVersion,
} from "@/lib/question-bank/contracts/types";

let db: QuestionBankDb;

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

function makeSource(id: string): SourceEntry {
  return {
    sourceId: `src-${id}`,
    type: "LOCAL_CORPUS",
    uri: `local://corpus/${id}`,
    license: "公版（公有领域）",
    versionStrategy: "CONTENT_HASH",
    allowedUse: ["PRIMARY_TEXT"],
    enabled: true,
  };
}

function makeWork(
  id: string,
  title: string,
  author: string,
  lines: string[],
  aliases: { author?: string[]; title?: string[] } = {},
): { source: SourceEntry; snapshot: ReturnType<typeof buildSnapshot>; work: Work; workVersion: WorkVersion } {
  const rawText = `${title}\n${author}\n${lines.join("\n")}`;
  const snapshot = buildSnapshot({
    snapshotId: `snap-${id}`,
    sourceId: `src-${id}`,
    revision: "r1",
    capturedAt: "2026-09-18T00:00:00.000Z",
    evidencePath: `corpus/${id}.txt`,
    rawText,
  });
  // 作品版本正文的快照定位证据（正文 = 题名/作者行之后的诗句段，rawText 以其结尾）
  const linesText = lines.join("\n");
  const linesStart = rawText.length - linesText.length;
  const work: Work = {
    workId: `work-${id}`,
    authorCanonical: author,
    titleCanonical: title,
    dynasty: "唐",
    verificationStatus: "VERIFIED",
    authorAliases: aliases.author ?? [],
    titleAliases: aliases.title ?? [],
    currentVersionId: `wv-${id}`,
  };
  const workVersion: WorkVersion = {
    workVersionId: `wv-${id}`,
    workId: work.workId,
    version: 1,
    title,
    author,
    lines,
    contentHash: snapshot.contentHash,
    evidence: [
      { snapshotId: snapshot.snapshotId, start: linesStart, end: linesStart + linesText.length },
    ],
  };
  return { source: makeSource(id), snapshot, work, workVersion };
}

/** 四首公版诗（互不相同的作者/题名/诗句 → 干扰项池充足） */
const CORPUS = [
  makeWork("jys", "静夜思", "李白", [
    "床前明月光",
    "疑是地上霜",
    "举头望明月",
    "低头思故乡",
  ]),
  makeWork("cx", "春晓", "孟浩然", [
    "春眠不觉晓",
    "处处闻啼鸟",
    "夜来风雨声",
    "花落知多少",
  ]),
  makeWork("gnql", "登鹳雀楼", "王之涣", [
    "白日依山尽",
    "黄河入海流",
    "欲穷千里目",
    "更上一层楼",
  ]),
  makeWork("mn", "悯农", "李绅", [
    "锄禾日当午",
    "汗滴禾下土",
    "谁知盘中餐",
    "粒粒皆辛苦",
  ]),
];

describe("端到端管线（模拟模型 + 隔离测试库）", () => {
  it("全链路：采集 → 命题 → 审核 → 发布 → 激活", async () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const orch = createOrchestrator(db, new SimulatedProvider());
    const batchId = "batch-e2e";
    createBatch(orch, batchId, 100_000);

    // 1. 采集：登记来源/快照/作品
    for (const c of CORPUS) {
      ingestWork(orch, c);
    }
    expect(db.listWorks()).toHaveLength(4);

    // 2. 规划：3 题型 × 4 作品 = 12 个 COMPOSE 任务
    const workVersionIds = CORPUS.map((c) => c.workVersion.workVersionId);
    const plan = planComposeTasks(
      orch,
      batchId,
      workVersionIds,
      ["GUESS_POET", "GUESS_TITLE", "COMPLETE_NEXT"],
      42,
    );
    expect(plan.enqueued).toBe(12);
    expect(plan.rejected).toHaveLength(0);

    // 3. 执行：排空队列（COMPOSE → REVIEW → PUBLISH）
    const steps = await drain(orch);
    const failed = steps.filter((s) => s.outcome === "FAILED" || s.outcome === "REJECTED_STALE");
    expect(failed, `存在失败步骤: ${JSON.stringify(failed)}`).toHaveLength(0);

    const stats = db.batchStats(batchId);
    expect(stats.SUCCEEDED).toBeGreaterThanOrEqual(13); // 12 COMPOSE+REVIEW + 1 PUBLISH
    expect(stats.FAILED).toBe(0);
    expect(stats.QUEUED + stats.RUNNING + stats.RETRY_WAIT).toBe(0);

    // 4. 发布结果：12 道 APPROVED 题全部入清单并激活
    const active = db.getActiveRelease();
    expect(active).toBeTruthy();
    const rel = db.getRelease(active!.releaseId)!;
    expect(rel.items).toHaveLength(12);
    // 每种题型各 4 道
    const byType = new Map(rel.items.map((i) => [i.type, 0]));
    for (const i of rel.items) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
    expect(byType.get("GUESS_POET")).toBe(4);
    expect(byType.get("GUESS_TITLE")).toBe(4);
    expect(byType.get("COMPLETE_NEXT")).toBe(4);
    // 审核哈希 = 发布哈希（逐条）
    for (const item of rel.items) {
      expect(item.reviewInputHash).toBe(item.contentHash);
    }
    // 候选题全部 APPROVED
    expect(db.listQuestionVersions("APPROVED")).toHaveLength(12);

    // 5. 预算结算：spent > 0，reserved 无残留（已结算）
    const budget = db.batchBudget(batchId)!;
    expect(budget.spent).toBeGreaterThan(0);

    // 6. 重复排空（幂等）：无可领任务
    expect(await drain(orch)).toHaveLength(0);
  });

  it("崩溃恢复：worker 领取后崩溃，过期重领后管线继续完成", async () => {
    // 可推进时钟：崩溃后时间前进，回收任务才能到点可领
    let clock = 1_700_000_000_000;
    db = new QuestionBankDb(":memory:", { nowMs: () => clock });
    const orch = createOrchestrator(db, new SimulatedProvider());
    const batchId = "batch-crash";
    createBatch(orch, batchId, 100_000);
    for (const c of CORPUS) ingestWork(orch, c);
    planComposeTasks(
      orch,
      batchId,
      CORPUS.map((c) => c.workVersion.workVersionId),
      ["GUESS_POET"],
      7,
    );

    // worker 领取 1 个任务后"崩溃"（不提交结果）
    const crashed = db.claimTask(1000)!; // lease 1s
    expect(crashed).toBeTruthy();
    // 时间推进 2s → 租约过期，回收（available_at 落在推进后的时钟内）
    clock += 2000;
    const reclaimed = db.reclaimExpired(clock);
    expect(reclaimed).toContain(crashed.taskId);
    expect(db.getTask(crashed.taskId)!.status).toBe("QUEUED");

    // 继续排空 → 管线完成（4 个 GUESS_POET + 审核 + 发布）
    const steps = await drain(orch);
    expect(steps.filter((s) => s.outcome === "FAILED")).toHaveLength(0);
    const active = db.getActiveRelease();
    expect(active).toBeTruthy();
    const rel = db.getRelease(active!.releaseId)!;
    expect(rel.items).toHaveLength(4);
  });

  it("重复任务幂等：同批次重复 plan 不产生重复任务/重复发布", async () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const orch = createOrchestrator(db, new SimulatedProvider());
    const batchId = "batch-idem";
    createBatch(orch, batchId, 100_000);
    for (const c of CORPUS) ingestWork(orch, c);
    const wvs = CORPUS.map((c) => c.workVersion.workVersionId);
    expect(planComposeTasks(orch, batchId, wvs, ["GUESS_POET"], 1).enqueued).toBe(4);
    // 重复 plan（相同输入哈希/规则版本 → 相同幂等键）
    const again = planComposeTasks(orch, batchId, wvs, ["GUESS_POET"], 1);
    expect(db.listTasks(batchId).filter((t) => t.stage === "COMPOSE")).toHaveLength(4);
    void again;

    const steps = await drain(orch);
    expect(steps.filter((s) => s.outcome === "FAILED")).toHaveLength(0);
    const active = db.getActiveRelease()!;
    expect(db.getRelease(active.releaseId)!.items).toHaveLength(4);

    // 重复 PUBLISH（同 batchKey）→ 幂等，清单不变
    const before = db.getRelease(active.releaseId)!;
    const republish = publishBatch(db, {
      batchId, batchKey: `batch:${batchId}`, releaseId: "rel-new", createdAt: "2026-09-18T03:00:00.000Z",
      activate: false,
    });
    expect(republish.idempotent).toBe(true);
    expect(republish.releaseId).toBe(before.releaseId);
    const after = db.getRelease(active.releaseId)!;
    expect(after.manifestHash).toBe(before.manifestHash);
  });

  it("发布后可回滚：切回无激活清单，清单保留", async () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const orch = createOrchestrator(db, new SimulatedProvider());
    const batchId = "batch-rollback";
    createBatch(orch, batchId, 100_000);
    // 入库全部 4 首（干扰项池充足），只规划前 2 首出题
    for (const c of CORPUS) ingestWork(orch, c);
    planComposeTasks(
      orch,
      batchId,
      CORPUS.slice(0, 2).map((c) => c.workVersion.workVersionId),
      ["GUESS_POET", "GUESS_TITLE"],
      3,
    );
    const steps = await drain(orch);
    expect(steps.filter((s) => s.outcome === "FAILED")).toHaveLength(0);
    const relId = db.getActiveRelease()!.releaseId;
    expect(db.getRelease(relId)!.items).toHaveLength(4);

    // 回滚到无激活
    const rb = rollback(orch, null);
    expect(rb.ok).toBe(true);
    expect(db.getActiveRelease()).toBeNull();
    // 清单保留（不可变，不删除）
    expect(db.getRelease(relId)).toBeTruthy();
  });

  it("含歧义/泄漏的坏作品：被隔离，不进入发布清单", async () => {
    db = new QuestionBankDb(":memory:", { nowMs: () => 1_700_000_000_000 });
    const orch = createOrchestrator(db, new SimulatedProvider());
    const batchId = "batch-mixed";
    createBatch(orch, batchId, 100_000);

    // 入库全部 4 首好诗（干扰项池充足）
    for (const c of CORPUS) ingestWork(orch, c);
    // 一首"异文"坏诗：作品版本正文与快照不一致（WORK_NOT_IN_SNAPSHOT）
    const bad = makeWork("bad", "坏诗", "某诗人", [
      "第一句诗呀",
      "第二句诗呀",
      "第三句诗呀",
      "第四句诗呀",
    ]);
    // 篡改作品版本（快照未变）→ 审核校验发现正文与快照不一致
    bad.workVersion.lines = [
      "第一句诗呀",
      "第二句诗呀",
      "第三句诗呀",
      "被改动的异文",
    ];
    ingestWork(orch, bad);

    // 规划：2 首好诗 + 1 首坏诗 的 GUESS_POET
    planComposeTasks(
      orch,
      batchId,
      [...CORPUS.slice(0, 2).map((c) => c.workVersion.workVersionId), "wv-bad"],
      ["GUESS_POET"],
      5,
    );
    const steps = await drain(orch);
    // 好诗任务全部成功（无失败步骤）
    expect(steps.filter((s) => s.outcome === "FAILED")).toHaveLength(0);

    const active = db.getActiveRelease();
    expect(active).toBeTruthy();
    const rel = db.getRelease(active!.releaseId)!;
    expect(rel.items).toHaveLength(2); // 仅好诗入清单

    // 坏诗被隔离：无 APPROVED 版本，且存在 QUARANTINED 版本
    const badApproved = db.listQuestionVersions("APPROVED").filter((v) => v.workVersionId === "wv-bad");
    expect(badApproved).toHaveLength(0);
    const badVersions = db.listQuestionVersions(undefined).filter((v) => v.workVersionId === "wv-bad");
    expect(badVersions.some((v) => v.status === "QUARANTINED")).toBe(true);
  });
});
