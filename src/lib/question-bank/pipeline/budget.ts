/**
 * 智能体题库引擎 · 预算规则（纯函数）
 *
 * 设计稿第 6 节：
 * - 运行和每任务都有 token/调用量预算，按最坏输出预留额度。
 * - 耗尽进入 PAUSED 并报告已完成部分，不能无限重试。
 * - 瞬时网络错误最多重试 3 次并退避；内容修订最多 2 轮。
 */

import {
  DEFAULT_BUDGET_RULES,
  type BudgetLedgerEntry,
  type BudgetRules,
  type TaskRecord,
} from "../contracts/types";

/** 批次预算视图（随任务提交实时结算） */
export interface BatchBudgetState {
  rules: BudgetRules;
  /** 已预留（未结算） */
  reserved: number;
  /** 已结算（实际消耗） */
  spent: number;
  /** 已入队/在跑任务数 */
  taskCount: number;
}

export function createBatchBudgetState(rules?: Partial<BudgetRules>): BatchBudgetState {
  return {
    rules: { ...DEFAULT_BUDGET_RULES, ...rules },
    reserved: 0,
    spent: 0,
    taskCount: 0,
  };
}

/** 批次可用额度：总预算 − 已预留 − 已结算 */
export function batchRemaining(state: BatchBudgetState): number {
  return state.rules.batchTokenBudget - state.reserved - state.spent;
}

export function batchExhausted(state: BatchBudgetState): boolean {
  return batchRemaining(state) <= 0;
}

/** 按最坏输出估算单任务预留（取上限与估算的较大者） */
export function estimateReserve(
  rules: BudgetRules,
  worstCaseTokens: number,
): number {
  return Math.min(rules.perTaskTokenCap, Math.max(worstCaseTokens, 0));
}

/**
 * 新任务准入：检查批次任务数上限与预算；不通过时给出原因。
 * 通过后调用方应「先预留再入队」（避免超卖）。
 */
export function admitTask(
  state: BatchBudgetState,
  reserve: number,
): { ok: true; next: BatchBudgetState } | { ok: false; reason: string } {
  if (state.taskCount >= state.rules.batchTaskCap) {
    return { ok: false, reason: `批次任务数已达上限 ${state.rules.batchTaskCap}` };
  }
  if (reserve > batchRemaining(state)) {
    return {
      ok: false,
      reason: `批次预算不足：需预留 ${reserve}，剩余 ${batchRemaining(state)}`,
    };
  }
  return {
    ok: true,
    next: { ...state, reserved: state.reserved + reserve, taskCount: state.taskCount + 1 },
  };
}

/** 结算：任务成功/失败后以实际消耗替换预留（只多补不超扣） */
export function settleTask(
  state: BatchBudgetState,
  actualTokens: number,
  reservedTokens: number,
): BatchBudgetState {
  return {
    ...state,
    reserved: Math.max(0, state.reserved - reservedTokens),
    spent: state.spent + Math.max(actualTokens, 0),
  };
}

/** 任务失败放弃预留（未消耗部分退回批次额度） */
export function releaseReserve(
  state: BatchBudgetState,
  reservedTokens: number,
): BatchBudgetState {
  return { ...state, reserved: Math.max(0, state.reserved - reservedTokens) };
}

/** 指数退避（毫秒）：base * 2^(attempt-1)，封顶 capMs */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  if (attempt < 1) return 0;
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

/**
 * 失败处置决策（纯函数，任务队列消费）：
 * - PERMANENT → FAILED（不重试）
 * - TRANSIENT 且 attempt < maxTransientRetries → RETRY_WAIT（退避后重领）
 * - TRANSIENT 且达到重试上限 → FAILED
 * - 批次预算耗尽 → PAUSED（报告已完成部分）
 */
export type FailureDecision =
  | { action: "RETRY"; backoffMs: number }
  | { action: "FAIL"; reason: string }
  | { action: "PAUSE"; reason: string };

export function decideFailure(input: {
  task: Pick<TaskRecord, "attempt" | "lastError" | "stage">;
  batch: BatchBudgetState;
  now: string;
}): FailureDecision {
  const { task, batch } = input;
  const kind = task.lastError?.kind ?? "TRANSIENT";

  if (batchExhausted(batch) && kind === "TRANSIENT") {
    return {
      action: "PAUSE",
      reason: "批次预算耗尽，任务转入 PAUSED（已完成部分保留，待人工续跑）",
    };
  }
  if (kind === "PERMANENT" || !task.lastError) {
    return {
      action: "FAIL",
      reason: task.lastError?.message ?? "永久错误，不再重试",
    };
  }
  if (task.attempt >= batch.rules.maxTransientRetries) {
    return {
      action: "FAIL",
      reason: `瞬时错误重试已达上限 ${batch.rules.maxTransientRetries}`,
    };
  }
  return { action: "RETRY", backoffMs: backoffMs(task.attempt) };
}

/** 修订轮次上限判定：超过 → 待核验（QUARANTINED），不得继续自动修订 */
export function revisionExhausted(
  currentRound: number,
  rules: BudgetRules = DEFAULT_BUDGET_RULES,
): boolean {
  return currentRound >= rules.maxRevisionRounds;
}

/** 预算账本追加（只增，审计用） */
export function appendLedger(
  ledger: BudgetLedgerEntry[],
  entry: Omit<BudgetLedgerEntry, "createdAt"> & { createdAt?: string },
): BudgetLedgerEntry[] {
  return [
    ...ledger,
    {
      entryId: entry.entryId,
      taskId: entry.taskId,
      kind: entry.kind,
      amount: entry.amount,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    },
  ];
}
