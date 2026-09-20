/**
 * 智能体题库引擎 · 编排器 / worker 主循环（P1）
 *
 * 设计稿第 2/3/6 节：
 * - 调度器创建批次并排队任务（幂等键 = 阶段 + 输入哈希 + 规则/提示版本）；
 * - worker 原子领取租约、心跳、提交结果（leaseToken 匹配才接受）；
 * - 崩溃恢复：过期任务重领，旧 worker 迟到结果拒绝；
 * - 预算：入队前预留，成功结算实际消耗，失败/暂停释放预留。
 *
 * 阶段执行（P1 模拟闭环）：
 *   COMPOSE  模板命题（composer）→ 保存 v1 → 排队 REVIEW
 *   REVIEW   校验 + 独立审核 + 修订闭环（ReviewPipeline）
 *   PUBLISH  构建清单 + 验收 + 原子激活（publisher）
 *
 * 本模块零网络、零真实模型（provider 注入，P1 用 SimulatedProvider）。
 */

import { composeQuestion } from "./composer";
import { ReviewPipeline } from "./review";
import { publishBatch, rollbackTo, PUBLISHER_RULE_VERSION } from "./publisher";
import { sha256Hex } from "../sources/evidence";
import {
  DEFAULT_BUDGET_RULES,
  type BudgetRules,
  type QuestionProvider,
  type QuestionType,
  type SourceEntry,
  type SourceSnapshot,
  type Work,
  type WorkVersion,
} from "../contracts/types";
import type { QuestionBankDb } from "../infra/question-bank-db";

export const RULE_VERSION = "rules-v1";
export const PROMPT_VERSIONS: Record<string, string> = {
  COMPOSE: "compose-v1",
  REVIEW: "review-v1",
  PUBLISH: "publish-v1",
};

export interface WorkerStepResult {
  taskId: string;
  stage: string;
  outcome: "SUCCEEDED" | "FAILED" | "PAUSED" | "RETRY_WAIT" | "REJECTED_STALE";
  detail: string;
  tokensUsed: number;
}

export interface PipelineOrchestrator {
  db: QuestionBankDb;
  provider: QuestionProvider;
  rules: BudgetRules;
}

/** 任务预算预留（token 当量，按最坏输出预留；P1 固定值） */
const TASK_RESERVE: Record<string, number> = {
  COMPOSE: 500,
  REVIEW: 800,
  PUBLISH: 200,
};

export function createOrchestrator(
  db: QuestionBankDb,
  provider: QuestionProvider,
  rules?: Partial<BudgetRules>,
): PipelineOrchestrator {
  return {
    db,
    provider,
    rules: { ...DEFAULT_BUDGET_RULES, ...rules },
  };
}

/** 建批次（幂等） */
export function createBatch(
  orch: PipelineOrchestrator,
  batchId: string,
  tokenBudget: number,
): void {
  orch.db.upsertBatch(batchId, tokenBudget);
}

/** 登记来源/快照/作品/作品版本（采集 agent 的输出落库；幂等） */
export function ingestWork(
  orch: PipelineOrchestrator,
  input: {
    source: SourceEntry;
    snapshot: SourceSnapshot;
    work: Work;
    workVersion: WorkVersion;
  },
): void {
  orch.db.upsertSource(input.source);
  orch.db.saveSnapshot(input.snapshot);
  orch.db.saveWorkVersion(input.workVersion);
  orch.db.upsertWork(input.work);
}

/**
 * 规划命题任务：为每个作品版本 × 题型建 COMPOSE 任务（幂等）。
 * 干扰项池从库内其他 VERIFIED 作品构建（作者池/题名池/诗句池）。
 */
export function planComposeTasks(
  orch: PipelineOrchestrator,
  batchId: string,
  workVersionIds: string[],
  types: QuestionType[],
  seedBase: number,
): { enqueued: number; rejected: Array<{ workVersionId: string; type: QuestionType; reason: string }> } {
  let enqueued = 0;
  const rejected: Array<{ workVersionId: string; type: QuestionType; reason: string }> = [];

  for (const wvId of workVersionIds) {
    for (const [ti, type] of types.entries()) {
      const wv = orch.db.getWorkVersion(wvId);
      if (!wv) {
        rejected.push({ workVersionId: wvId, type, reason: "作品版本不存在" });
        continue;
      }
      const pool = buildDistractorPool(orch.db, type, wvId);
      const inputHash = sha256Hex(
        `${type}|${wv.workVersionId}|${wv.contentHash}|${pool.join(",")}`,
      );
      const seed = seedBase + ti;
      // 幂等键含 batchId：任务队列幂等为「批次作用域」（同批次重跑幂等；
      // 不同批次是独立运行、各自结算预算，不得互相阻塞）。候选题的全局
      // 去重由 question_versions / 题面指纹承担，与此层正交。
      const idemKey = `COMPOSE:${batchId}:${inputHash}:${PROMPT_VERSIONS.COMPOSE}:${RULE_VERSION}`;
      const res = orch.db.reserveAndEnqueue(batchId, {
        taskId: `t-${batchId}-${wvId}-${type}-${seed}`,
        batchId,
        stage: "COMPOSE",
        idempotencyKey: idemKey,
        inputHash,
        ruleVersion: RULE_VERSION,
        promptVersion: PROMPT_VERSIONS.COMPOSE,
        maxAttempts: orch.rules.maxTransientRetries + 1,
        backoffMs: 1000,
        budgetReserved: TASK_RESERVE.COMPOSE,
        inputPayload: { workVersionId: wvId, type, seed },
      });
      if (res.ok) {
        enqueued++;
      } else {
        rejected.push({ workVersionId: wvId, type, reason: res.reason });
        // 预算耗尽 → 批次暂停（已完成部分保留）
        orch.db.pauseUnfinishedByBatch(batchId);
      }
    }
  }
  return { enqueued, rejected };
}

/** 从库内其他 VERIFIED 作品构建干扰项池（同类型合规项） */
function buildDistractorPool(
  db: QuestionBankDb,
  type: QuestionType,
  excludeWorkVersionId: string,
): string[] {
  const pool: string[] = [];
  // 扫描所有已登记作品（P1 数据量小；真实系统走索引查询）
  for (const work of db.listWorks()) {
    if (work.verificationStatus !== "VERIFIED") continue;
    const wv = db.getWorkVersion(work.currentVersionId);
    if (!wv) continue;
    if (wv.workVersionId === excludeWorkVersionId) continue;
    if (type === "GUESS_POET") pool.push(wv.author);
    if (type === "GUESS_TITLE") pool.push(wv.title);
    if (type === "COMPLETE_NEXT") pool.push(...wv.lines);
  }
  return [...new Set(pool)];
}

/** 领取并执行一个任务（worker 单步；REVIEW 阶段为异步） */
export async function workOnce(
  orch: PipelineOrchestrator,
  opts: { leaseMs?: number } = {},
): Promise<WorkerStepResult | null> {
  const { db, provider, rules } = orch;
  const task = db.claimTask(opts.leaseMs ?? 30_000);
  if (!task) return null;

  if (!task.leaseToken) {
    // 理论不可达：claimTask 必设租约令牌
    return {
      taskId: task.taskId, stage: task.stage,
      outcome: "REJECTED_STALE", detail: "领取任务缺少租约令牌", tokensUsed: 0,
    };
  }
  const leaseToken = task.leaseToken;

  const payload = db.getTaskPayload(task.taskId);
  const tokens = { used: 0 };

  try {
    switch (task.stage) {
      case "COMPOSE": {
        const wvId = payload.workVersionId as string;
        const type = payload.type as QuestionType;
        const seed = (payload.seed as number) ?? 1;
        const wv = db.getWorkVersion(wvId);
        const work = wv ? db.getWork(wv.workId) : null;
        const snap = wv && wv.evidence[0] ? db.getSnapshot(wv.evidence[0].snapshotId) : null;
        if (!wv || !work || !snap) {
          throw permanent(`COMPOSE 输入缺失: ${wvId}`);
        }
        const source = db.getSource(snap.sourceId);
        if (!source) throw permanent(`来源不存在: ${snap.sourceId}`);
        const pool = buildDistractorPool(db, type, wvId);
        const composed = composeQuestion({
          type, work, workVersion: wv, snapshot: snap, distractorPool: pool, seed,
        });
        if (!composed.ok || !composed.version) {
          throw permanent(`命题失败: ${composed.issues.map((i) => i.code).join(",")}`);
        }
        const saved = db.saveQuestionVersion(composed.version);
        if (!saved.saved) {
          // 幂等：已存在（重领重跑）→ 视为成功
          tokens.used = 40;
          break;
        }
        // 排 REVIEW 任务（幂等键含 batchId：批次作用域，见 COMPOSE 处说明）
        const inputHash = composed.version.contentHash;
        const idemKey = `REVIEW:${task.batchId}:${inputHash}:${PROMPT_VERSIONS.REVIEW}:${RULE_VERSION}`;
        const enq = db.reserveAndEnqueue(task.batchId, {
          taskId: `t-${task.batchId}-review-${composed.version.questionId}`,
          batchId: task.batchId,
          stage: "REVIEW",
          idempotencyKey: idemKey,
          inputHash,
          ruleVersion: RULE_VERSION,
          promptVersion: PROMPT_VERSIONS.REVIEW,
          maxAttempts: rules.maxTransientRetries + 1,
          backoffMs: 1000,
          budgetReserved: TASK_RESERVE.REVIEW,
          inputPayload: {
            questionId: composed.version.questionId,
            version: composed.version.version,
            workVersionId: wvId,
            distractorPool: composed.distractorPool,
          },
        });
        if (!enq.ok) {
          throw new Error(`REVIEW 入队失败（预算）: ${enq.reason}`);
        }
        tokens.used = 60;
        break;
      }
      case "REVIEW": {
        const questionId = payload.questionId as string;
        const versionNo = (payload.version as number) ?? 1;
        const wvId = payload.workVersionId as string;
        const distractorPool = (payload.distractorPool as string[]) ?? [];
        const wv = db.getWorkVersion(wvId);
        const work = wv ? db.getWork(wv.workId) : null;
        const snap = wv && wv.evidence[0] ? db.getSnapshot(wv.evidence[0].snapshotId) : null;
        const source = snap ? db.getSource(snap.sourceId) : null;
        if (!wv || !work || !snap || !source) {
          throw permanent(`REVIEW 输入缺失: ${wvId}`);
        }
        const cur = db.getQuestionVersion(questionId, versionNo);
        if (!cur) throw permanent(`候选题不存在: ${questionId} v${versionNo}`);

        const review = new ReviewPipeline({
          db,
          provider,
          rules,
          nowIso: () => new Date(dbNowMs()).toISOString(),
        });
        const outcome = await review.run(
          { version: cur, distractorPool },
          { source, snapshot: snap, work, workVersion: wv },
        );
        tokens.used = 300;
        if (outcome.approved) {
          // 排 PUBLISH 任务（幂等：每批次一个）
          enqueuePublishTask(orch, task.batchId);
        }
        break;
      }
      case "PUBLISH": {
        const batchId = payload.batchId as string;
        const batchKey = (payload.batchKey as string) ?? `batch:${batchId}`;
        const res = publishBatch(orch.db, {
          batchId,
          batchKey,
          releaseId: `rel-${batchId}`,
          createdAt: new Date(dbNowMs()).toISOString(),
          activate: true,
        });
        tokens.used = 20;
        if (!res.ok) {
          // 验收失败 → 任务永久失败（不重试；内容问题需人工处理）
          throw permanent(`发布失败: ${res.reason ?? "未知"}`);
        }
        break;
      }
      default:
        throw permanent(`未知阶段 ${task.stage}`);
    }
  } catch (e) {
    const err = e as { kind?: "TRANSIENT" | "PERMANENT"; message?: string };
    const kind = err.kind ?? "PERMANENT";
    const message = err.message ?? String(e);
    const res = db.failTask(task.taskId, leaseToken, { kind, message });
    if (!res.accepted) {
      // 旧租约迟到（理论上不会发生：本 worker 持有最新租约）
      return {
        taskId: task.taskId, stage: task.stage,
        outcome: "REJECTED_STALE", detail: "结果被拒绝（租约失效）", tokensUsed: 0,
      };
    }
    // 预算：终态/暂停 → 释放预留
    if (res.newStatus === "FAILED" || res.newStatus === "PAUSED") {
      db.settleBatchBudget(task.batchId, task.budgetReserved, 0);
    }
    return {
      taskId: task.taskId, stage: task.stage,
      outcome: (res.newStatus as WorkerStepResult["outcome"]) ?? "FAILED",
      detail: message, tokensUsed: 0,
    };
  }

  // 成功提交（leaseToken 必须匹配）
  const ok = db.completeTask(task.taskId, leaseToken, tokens.used);
  if (!ok) {
    return {
      taskId: task.taskId, stage: task.stage,
      outcome: "REJECTED_STALE", detail: "成功结果被拒绝（租约失效）", tokensUsed: 0,
    };
  }
  db.settleBatchBudget(task.batchId, task.budgetReserved, tokens.used);
  return {
    taskId: task.taskId, stage: task.stage,
    outcome: "SUCCEEDED", detail: "ok", tokensUsed: tokens.used,
  };
}

/** 排 PUBLISH 任务（幂等：每批次一个） */
export function enqueuePublishTask(
  orch: PipelineOrchestrator,
  batchId: string,
): { ok: boolean; reason?: string } {
  const batchKey = `batch:${batchId}`;
  const inputHash = sha256Hex(`PUBLISH|${batchKey}|${PUBLISHER_RULE_VERSION}`);
  const res = orch.db.reserveAndEnqueue(batchId, {
    taskId: `t-${batchId}-publish`,
    batchId,
    stage: "PUBLISH",
    idempotencyKey: `PUBLISH:${inputHash}:${PROMPT_VERSIONS.PUBLISH}:${RULE_VERSION}`,
    inputHash,
    ruleVersion: RULE_VERSION,
    promptVersion: PROMPT_VERSIONS.PUBLISH,
    maxAttempts: orch.rules.maxTransientRetries + 1,
    backoffMs: 1000,
    budgetReserved: TASK_RESERVE.PUBLISH,
    inputPayload: { batchId, batchKey },
  });
  return res.ok ? { ok: true } : { ok: false, reason: res.reason };
}

/** 排空队列（直到无可领任务或达到 maxLoops） */
export async function drain(
  orch: PipelineOrchestrator,
  maxLoops = 200,
): Promise<WorkerStepResult[]> {
  const steps: WorkerStepResult[] = [];
  for (let i = 0; i < maxLoops; i++) {
    const s = await workOnce(orch);
    if (!s) break;
    steps.push(s);
  }
  return steps;
}

/** 回滚（对外封装） */
export function rollback(
  orch: PipelineOrchestrator,
  target: string | null,
): { ok: boolean; reason?: string } {
  return rollbackTo(orch.db, target, new Date(dbNowMs()).toISOString());
}

/* --------------------------- 内部 --------------------------- */

class PermanentError extends Error {
  kind = "PERMANENT" as const;
}
function permanent(message: string): PermanentError {
  return new PermanentError(message);
}

function dbNowMs(): number {
  // QuestionBankDb 的 nowMs 是私有；P1 用 Date.now()（测试注入时钟在 DB 构造时）
  return Date.now();
}
