/**
 * 智能体题库引擎 · 状态机（纯函数）
 *
 * 候选题状态（设计稿第 6 节）：
 *   DRAFT → VALIDATING → REVIEWING → APPROVED
 *   分流：NEEDS_REVISION / QUARANTINED / REJECTED
 *   APPROVED = 内容审核通过，不代表已发布。
 *   修订创建新版本并从 VALIDATING 重跑。
 *
 * 任务状态（设计稿第 6 节）：
 *   QUEUED / RUNNING / RETRY_WAIT / SUCCEEDED / FAILED / PAUSED
 *   预算耗尽 → PAUSED；有限重试 → RETRY_WAIT → QUEUED 重领。
 */

import type { CandidateStatus, TaskStatus } from "./types";

/** 候选题合法状态转换表（白名单；未列出的转换一律拒绝） */
export const CANDIDATE_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  DRAFT: ["VALIDATING"],
  VALIDATING: ["REVIEWING", "NEEDS_REVISION", "QUARANTINED", "REJECTED"],
  REVIEWING: ["APPROVED", "NEEDS_REVISION", "QUARANTINED", "REJECTED"],
  /** 修订：创建新版本并从 VALIDATING 重跑（新版本首状态为 DRAFT/VALIDATING） */
  APPROVED: ["VALIDATING"],
  /** 修订后重入校验 */
  NEEDS_REVISION: ["VALIDATING"],
  QUARANTINED: ["VALIDATING", "REJECTED"],
  REJECTED: [],
};

/** 候选题状态迁移是否合法 */
export function canTransitionCandidate(
  from: CandidateStatus,
  to: CandidateStatus,
): boolean {
  return CANDIDATE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 执行候选题状态迁移；非法迁移抛错（调用方应视为硬失败，
 * 而不是静默放行）。
 */
export function transitionCandidate(
  from: CandidateStatus,
  to: CandidateStatus,
): CandidateStatus {
  if (!canTransitionCandidate(from, to)) {
    throw new Error(
      `非法候选题状态迁移: ${from} → ${to}（合法目标: ${
        CANDIDATE_TRANSITIONS[from]?.join(", ") ?? "无"
      }）`,
    );
  }
  return to;
}

/** 任务合法状态转换表 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["RUNNING", "PAUSED", "FAILED"],
  RUNNING: ["SUCCEEDED", "FAILED", "RETRY_WAIT", "PAUSED"],
  /** 退避到期或手动恢复后重新排队 */
  RETRY_WAIT: ["QUEUED", "PAUSED"],
  PAUSED: ["QUEUED", "RUNNING"],
  SUCCEEDED: [],
  FAILED: [],
};

/** 任务状态迁移是否合法 */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 执行任务状态迁移；非法迁移抛错 */
export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransitionTask(from, to)) {
    throw new Error(
      `非法任务状态迁移: ${from} → ${to}（合法目标: ${
        TASK_TRANSITIONS[from]?.join(", ") ?? "无"
      }）`,
    );
  }
  return to;
}

/** 终态判定（不可再迁移） */
export function isTerminalTask(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}

/** 终态判定（候选题 REJECTED 为唯一终态） */
export function isTerminalCandidate(status: CandidateStatus): boolean {
  return CANDIDATE_TRANSITIONS[status].length === 0;
}
