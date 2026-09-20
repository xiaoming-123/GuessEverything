/**
 * 智能体题库引擎 P0/P1 演示脚本
 *
 * 边界声明：
 * - 使用 SimulatedProvider（纯模拟，确定性执行），**不是真实模型**；
 *   不调用付费模型、不采集真实网站、不读取任何密钥。
 * - 使用 os.tmpdir() 下的一次性临时文件 SQLite 库（**隔离测试数据库**），
 *   运行结束后删除，绝不触碰生产数据库。
 *
 * 全链路：采集(模拟来源) → 命题(COMPOSE) → 审核(REVIEW) → 修订 → 发布(PUBLISH)
 *          → 幂等重发 → 崩溃恢复 → 回滚
 * 输出：结构化验收报告（stdout），任一验收项失败 → 进程退出码 1。
 *
 * 运行（项目根）：
 *   npx --no-install esbuild scripts/question-bank/demo.ts \
 *     --bundle --platform=node --format=esm \
 *     --outfile=node_modules/.cache/question-bank-demo.mjs \
 *   && node node_modules/.cache/question-bank-demo.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestionBankDb } from "../../src/lib/question-bank/infra/question-bank-db";
import {
  SIMULATED_PROVIDER_VERSION,
  SimulatedProvider,
} from "../../src/lib/question-bank/providers/simulated";
import { buildSnapshot } from "../../src/lib/question-bank/sources/evidence";
import {
  createBatch,
  createOrchestrator,
  drain,
  ingestWork,
  planComposeTasks,
  rollback,
  type PipelineOrchestrator,
} from "../../src/lib/question-bank/pipeline/orchestrator";
import { publishBatch } from "../../src/lib/question-bank/pipeline/publisher";
import { ReviewPipeline } from "../../src/lib/question-bank/pipeline/review";
import { questionContentHash } from "../../src/lib/question-bank/validators/rules";
import type {
  QuestionVersion,
  SourceEntry,
  Work,
  WorkVersion,
} from "../../src/lib/question-bank/contracts/types";

/* ----------------------------- 语料（公版诗） ----------------------------- */

function makeWork(
  id: string,
  title: string,
  author: string,
  lines: string[],
): {
  source: SourceEntry;
  snapshot: ReturnType<typeof buildSnapshot>;
  work: Work;
  workVersion: WorkVersion;
} {
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
    authorAliases: [],
    titleAliases: [],
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
  const source: SourceEntry = {
    sourceId: `src-${id}`,
    type: "LOCAL_CORPUS",
    uri: `local://corpus/${id}`,
    license: "公版（公有领域）",
    versionStrategy: "CONTENT_HASH",
    allowedUse: ["PRIMARY_TEXT"],
    enabled: true,
  };
  return { source, snapshot, work, workVersion };
}

const CORPUS = [
  makeWork("jys", "静夜思", "李白", ["床前明月光", "疑是地上霜", "举头望明月", "低头思故乡"]),
  makeWork("cx", "春晓", "孟浩然", ["春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少"]),
  makeWork("gnql", "登鹳雀楼", "王之涣", ["白日依山尽", "黄河入海流", "欲穷千里目", "更上一层楼"]),
  makeWork("mn", "悯农", "李绅", ["锄禾日当午", "汗滴禾下土", "谁知盘中餐", "粒粒皆辛苦"]),
];

/* ------------------------------- 验收框架 ------------------------------- */

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, cond: boolean, detail: string): void {
  checks.push({ name, pass: cond, detail });
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "question-bank-demo-"));
  const dbPath = join(tmp, "demo.db");
  const clock = 1_700_000_000_000;

  try {
    const db = new QuestionBankDb(dbPath, { nowMs: () => clock });
    const orch: PipelineOrchestrator = createOrchestrator(db, new SimulatedProvider());

    console.log("=== 智能体题库引擎 P0/P1 演示验收报告 ===");
    console.log(`隔离测试库 : ${dbPath}`);
    console.log(`provider   : ${SIMULATED_PROVIDER_VERSION}（纯模拟，非真实模型）`);
    console.log("");

    /* 1. 采集 */
    for (const c of CORPUS) ingestWork(orch, c);
    check(
      "采集：4 首公版诗入库",
      db.listWorks().length === 4,
      `入库作品 ${db.listWorks().length}/4`,
    );

    /* 2. 命题 + 审核 + 发布（全链路） */
    const batchId = "batch-demo";
    createBatch(orch, batchId, 100_000);
    const plan = planComposeTasks(
      orch,
      batchId,
      CORPUS.map((c) => c.workVersion.workVersionId),
      ["GUESS_POET", "GUESS_TITLE", "COMPLETE_NEXT"],
      42,
    );
    const steps = await drain(orch);
    const failed = steps.filter((s) => s.outcome === "FAILED" || s.outcome === "REJECTED_STALE");
    const approved = db.listQuestionVersions("APPROVED");
    const active = db.getActiveRelease();
    const rel = active ? db.getRelease(active.releaseId) : null;
    const byType = new Map<string, number>();
    for (const i of rel?.items ?? []) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
    const hashAlignedCount = (rel?.items ?? []).filter((i) => i.reviewInputHash === i.contentHash).length;
    const budget = db.batchBudget(batchId)!;

    check(
      "命题+审核+发布：12 题全 APPROVED 并激活",
      plan.enqueued === 12 && failed.length === 0 && approved.length === 12 &&
        !!rel && rel.items.length === 12 && byType.get("GUESS_POET") === 4 &&
        byType.get("GUESS_TITLE") === 4 && byType.get("COMPLETE_NEXT") === 4,
      `入队 ${plan.enqueued}/12，worker 步骤 ${steps.length}，失败 ${failed.length}，` +
        `APPROVED ${approved.length}/12，清单 ${rel?.items.length ?? 0}/12` +
        `（GUESS_POET ${byType.get("GUESS_POET")}/${byType.get("GUESS_TITLE")}/${byType.get("COMPLETE_NEXT")}），` +
        `激活 ${active?.releaseId ?? "无"}`,
    );
    check(
      "审核哈希 = 发布哈希（逐条）",
      (rel?.items.length ?? 0) > 0 && hashAlignedCount === (rel?.items.length ?? 0),
      `${hashAlignedCount}/${rel?.items.length ?? 0} 条一致`,
    );
    check(
      "预算结算（spent > 0，reserved 已结算）",
      budget.spent > 0 && budget.reserved === 0,
      `spent=${budget.spent}, reserved=${budget.reserved}`,
    );
    check("幂等重排空：无可领任务", (await drain(orch)).length === 0, "重复 drain 返回 0 步");

    /* 3. 幂等发布（同 batchKey 不产生第二份清单） */
    const repub = publishBatch(db, {
      batchId,
      batchKey: `batch:${batchId}`,
      releaseId: "rel-demo-retry",
      createdAt: new Date(clock).toISOString(),
      activate: false,
    });
    check(
      "幂等发布：同批次重复发布返回既有清单（不可变）",
      repub.ok === true && repub.idempotent === true && repub.releaseId === rel?.releaseId,
      `idempotent=${repub.idempotent}, releaseId=${repub.releaseId}（既有 ${rel?.releaseId}）`,
    );

    /* 4. 修订闭环（重复选项 → NEEDS_REVISION → v2 独立审核通过） */
    const cx = CORPUS[1]; // 春晓 / 孟浩然
    const rawIdx = (s: string) => cx.snapshot.rawText.indexOf(s);
    const badV1: QuestionVersion = {
      questionId: "q-cx-demo-revise",
      version: 1,
      type: "GUESS_POET",
      prompt: "春眠不觉晓",
      options: ["孟浩然", "孟浩然", "杜甫", "王维"],
      correctOptionId: "孟浩然",
      evidence: {
        promptSpan: { snapshotId: cx.snapshot.snapshotId, start: rawIdx("春眠不觉晓"), end: rawIdx("春眠不觉晓") + 5 },
        answerSpan: { snapshotId: cx.snapshot.snapshotId, start: rawIdx("孟浩然"), end: rawIdx("孟浩然") + 3 },
      },
      workVersionId: cx.workVersion.workVersionId,
      contentHash: "",
      status: "DRAFT",
    };
    badV1.contentHash = questionContentHash(badV1);
    db.saveQuestionVersion(badV1);
    const review = new ReviewPipeline({ db, provider: new SimulatedProvider() });
    const outcome = await review.run(
      { version: badV1, distractorPool: ["李白", "杜甫", "王维", "白居易"] },
      { source: cx.source, snapshot: cx.snapshot, work: cx.work, workVersion: cx.workVersion },
    );
    const v1 = db.getQuestionVersion("q-cx-demo-revise", 1);
    const v2 = db.getQuestionVersion("q-cx-demo-revise", 2);
    check(
      "修订闭环：v1(重复选项)→NEEDS_REVISION→v2 独立审核 APPROVED",
      outcome.approved && outcome.finalVersion === 2 && outcome.roundsUsed === 1 &&
        v1?.status === "NEEDS_REVISION" && v2?.status === "APPROVED",
      `termination=${outcome.termination}, roundsUsed=${outcome.roundsUsed}, ` +
        `v1=${v1?.status}, v2=${v2?.status}, v2 审核 inputHash 绑定 v2 contentHash=${v2 ? db.getLatestPassReview("q-cx-demo-revise", 2)?.inputHash === v2.contentHash : false}`,
    );

    /* 5-6. 崩溃恢复 + 回滚
     * 用独立隔离库运行（发布清单按 batchKey 累积全局 APPROVED 题，且候选题
     * 身份全局唯一；若与主批次共享题库，崩溃批次清单会并入主批次 12 题，
     * 无法单独表达"崩溃批次自洽发布 4 题"。独立库使该验收项自洽。） */
    {
      let clockCrash = 1_800_000_000_000;
      const crashDb = new QuestionBankDb(":memory:", { nowMs: () => clockCrash });
      const crashOrch = createOrchestrator(crashDb, new SimulatedProvider());
      const crashBatch = "batch-crash";
      createBatch(crashOrch, crashBatch, 100_000);
      for (const c of CORPUS) ingestWork(crashOrch, c);
      planComposeTasks(
        crashOrch,
        crashBatch,
        CORPUS.map((c) => c.workVersion.workVersionId),
        ["GUESS_POET"],
        7,
      );

      // worker 领取 1 个任务后"崩溃"（不提交结果）
      const crashed = crashDb.claimTask(1000); // lease 1s
      clockCrash += 2000; // 推进时钟：租约过期
      const reclaimed = crashDb.reclaimExpired(clockCrash);
      const crashSteps = await drain(crashOrch);
      const crashFailed = crashSteps.filter((s) => s.outcome === "FAILED");
      const crashActive = crashDb.getActiveRelease();
      const crashRel = crashActive ? crashDb.getRelease(crashActive.releaseId) : null;
      check(
        "崩溃恢复：过期回收后管线完成（4 题发布）",
        !!crashed && reclaimed.includes(crashed.taskId) && crashFailed.length === 0 &&
          !!crashRel && crashRel.items.length === 4,
        `回收 ${reclaimed.length} 项（含 ${crashed?.taskId}），失败 ${crashFailed.length}，清单 ${crashRel?.items.length ?? 0}/4`,
      );

      // 回滚：清空激活指针，清单保留
      const relBeforeRollback = crashActive!.releaseId;
      const rb = rollback(crashOrch, null);
      check(
        "回滚：切回无激活清单，清单保留（不可变，不删除）",
        rb.ok === true && crashDb.getActiveRelease() === null && !!crashDb.getRelease(relBeforeRollback),
        `ok=${rb.ok}, 当前激活=${crashDb.getActiveRelease()?.releaseId ?? "null"}, 清单 ${relBeforeRollback} 保留=${!!crashDb.getRelease(relBeforeRollback)}`,
      );
      crashDb.close();
    }

    db.close();
  } catch (e) {
    console.error("\n[异常] 演示执行失败：", e);
    checks.push({ name: "无未捕获异常", pass: false, detail: String(e) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  /* 验收报告 */
  console.log("\n--- 验收项 ---");
  let passed = 0;
  for (const c of checks) {
    const mark = c.pass ? "PASS" : "FAIL";
    if (c.pass) passed++;
    console.log(`[${mark}] ${c.name}\n       ${c.detail}`);
  }
  const total = checks.length;
  console.log(`\n=== 结果：${passed}/${total} 通过 ===`);
  if (passed !== total) {
    process.exitCode = 1;
  }
}

void main();
