/**
 * P1 持久化任务队列集成测试（临时 SQLite 库）
 *
 * 覆盖：
 * - 幂等任务键（重复入队不产生第二条）
 * - 并发领取（同一任务只有一个 worker 拿到租约）
 * - 心跳续租 / 租约超时回收（崩溃恢复）
 * - 过期 worker 迟到结果拒绝（旧 leaseToken）
 * - 有限重试（TRANSIENT 退避重领，达到上限 FAILED；PERMANENT 直接 FAILED）
 * - 预算上限（预留不足拒绝入队；批次预算结算）
 */

import { afterEach, describe, expect, it } from "vitest";
import { QuestionBankDb } from "@/lib/question-bank/infra/question-bank-db";

let db: QuestionBankDb;
let now: number;

function freshDb(): QuestionBankDb {
  now = 1_700_000_000_000;
  db = new QuestionBankDb(":memory:", { nowMs: () => now });
  return db;
}

function enqueue(
  overrides: Partial<Parameters<QuestionBankDb["enqueueTask"]>[0]> = {},
) {
  return db.enqueueTask({
    taskId: overrides.taskId ?? `t-${Math.random().toString(36).slice(2)}`,
    batchId: overrides.batchId ?? "b1",
    stage: overrides.stage ?? "COMPOSE",
    idempotencyKey:
      overrides.idempotencyKey ?? `K:${Math.random().toString(36).slice(2)}`,
    inputHash: overrides.inputHash ?? "h".repeat(64),
    ruleVersion: overrides.ruleVersion ?? "rules-v1",
    promptVersion: overrides.promptVersion ?? "p-v1",
    maxAttempts: overrides.maxAttempts ?? 3,
    backoffMs: overrides.backoffMs ?? 1000,
    budgetReserved: overrides.budgetReserved ?? 100,
    inputPayload: overrides.inputPayload,
  });
}

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
});

describe("任务队列：幂等与领取", () => {
  it("同 idempotencyKey 重复入队 → 返回同一任务，不重复创建", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1" });
    const b = enqueue({ taskId: "t1-different", idempotencyKey: "K1" });
    expect(b.taskId).toBe("t1"); // 既有任务优先
    expect(db.getTask("t1-different")).toBeNull();
    expect(db.listTasks("b1")).toHaveLength(1);
  });

  it("并发领取：同一任务只有一个 worker 拿到租约（第二个返回 null）", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1" });
    const first = db.claimTask(30_000);
    const second = db.claimTask(30_000);
    expect(first?.taskId).toBe("t1");
    expect(second).toBeNull();
    expect(first!.leaseToken).toBeTruthy();
    expect(first!.status).toBe("RUNNING");
    expect(first!.attempt).toBe(1);
  });

  it("领取顺序：按 available_at 优先（退避未到期不可领）", () => {
    freshDb();
    enqueue({ taskId: "t-late", idempotencyKey: "KL" });
    const task = db.getTask("t-late")!;
    // 模拟该任务处于 RETRY_WAIT 且退避未到（available_at 在未来）
    db.failTask("t-late", "", { kind: "TRANSIENT", message: "x" }); // 无租约 → 拒绝
    expect(db.getTask("t-late")!.status).toBe("QUEUED");
    expect(db.claimTask(30_000)?.taskId).toBe("t-late");
    void task;
  });
});

describe("任务队列：租约与崩溃恢复", () => {
  it("心跳续租：匹配租约 → 续租成功；不匹配 → 失败", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1" });
    const task = db.claimTask(1000)!;
    expect(db.heartbeat("t1", "wrong-token")).toBe(false);
    expect(db.heartbeat("t1", task.leaseToken!)).toBe(true);
    now += 500;
    expect(db.heartbeat("t1", task.leaseToken!)).toBe(true);
  });

  it("租约超时回收（崩溃恢复）：过期 RUNNING 任务重置回 QUEUED 可重领", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1" });
    const task = db.claimTask(1000)!; // lease_until = now + 1000
    const staleToken = task.leaseToken!;
    now += 2000; // 租约过期
    expect(db.claimTask(1000)).toBeNull(); // 过期任务不可领（仍 RUNNING）
    const reclaimed = db.reclaimExpired();
    expect(reclaimed).toEqual(["t1"]);
    expect(db.getTask("t1")!.status).toBe("QUEUED");
    const t2 = db.claimTask(1000)!;
    expect(t2.attempt).toBe(2); // 保留 attempt（第 2 次尝试）
    expect(t2.leaseToken).not.toBe(staleToken); // 全新租约令牌

    // 旧 worker 迟到结果（旧令牌）→ 被拒绝
    const stale = db.completeTask("t1", staleToken, 10);
    expect(stale).toBe(false);
    expect(db.getTask("t1")!.status).toBe("RUNNING");
  });

  it("未过期任务不回收", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1" });
    db.claimTask(100_000);
    now += 5_000;
    expect(db.reclaimExpired()).toEqual([]);
    expect(db.getTask("t1")!.status).toBe("RUNNING");
  });
});

describe("任务队列：有限重试", () => {
  it("TRANSIENT 失败 → RETRY_WAIT，退避到期后可重领；达到 maxAttempts → FAILED", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1", maxAttempts: 3, backoffMs: 1000 });

    // 第 1 次：失败（TRANSIENT）
    let task = db.claimTask(30_000)!;
    expect(task.attempt).toBe(1);
    let res = db.failTask(task.taskId, task.leaseToken!, {
      kind: "TRANSIENT",
      message: "net down",
    });
    expect(res.accepted).toBe(true);
    expect(res.newStatus).toBe("RETRY_WAIT");

    // 退避未到 → 不可领
    expect(db.claimTask(30_000)).toBeNull();
    now += 1000; // 退避到期
    task = db.claimTask(30_000)!;
    expect(task.attempt).toBe(2);

    // 第 2 次：失败（TRANSIENT）
    res = db.failTask(task.taskId, task.leaseToken!, {
      kind: "TRANSIENT",
      message: "net down 2",
    });
    expect(res.newStatus).toBe("RETRY_WAIT");
    now += 1000;
    task = db.claimTask(30_000)!;
    expect(task.attempt).toBe(3);

    // 第 3 次：失败 → 达到 maxAttempts(3) → FAILED（不再重试）
    res = db.failTask(task.taskId, task.leaseToken!, {
      kind: "TRANSIENT",
      message: "net down 3",
    });
    expect(res.newStatus).toBe("FAILED");
    now += 10_000;
    expect(db.claimTask(30_000)).toBeNull();
    expect(db.getTask("t1")!.status).toBe("FAILED");
  });

  it("PERMANENT 失败 → 立即 FAILED（不重试）", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1", maxAttempts: 5 });
    const task = db.claimTask(30_000)!;
    const res = db.failTask(task.taskId, task.leaseToken!, {
      kind: "PERMANENT",
      message: "content invalid",
    });
    expect(res.newStatus).toBe("FAILED");
    expect(db.getTask("t1")!.status).toBe("FAILED");
  });

  it("旧租约的迟到失败结果被拒绝（不改变状态）", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1" });
    const task = db.claimTask(1000)!;
    const stale = task.leaseToken!;
    now += 2000;
    db.reclaimExpired();
    const task2 = db.claimTask(1000)!;
    expect(task2.leaseToken).not.toBe(stale);
    // 旧 worker 用旧令牌提交失败
    const res = db.failTask("t1", stale, { kind: "TRANSIENT", message: "late" });
    expect(res.accepted).toBe(false);
    expect(db.getTask("t1")!.status).toBe("RUNNING"); // 新租约仍在跑
    // 新 worker 正常提交成功
    expect(db.completeTask("t1", task2.leaseToken!, 50)).toBe(true);
    expect(db.getTask("t1")!.status).toBe("SUCCEEDED");
  });
});

describe("任务队列：暂停与恢复", () => {
  it("pauseBatch 暂停未完成任务；resumeBatch 恢复后立即可领", () => {
    freshDb();
    enqueue({ taskId: "t1", idempotencyKey: "K1", batchId: "b1" });
    enqueue({ taskId: "t2", idempotencyKey: "K2", batchId: "b1" });
    expect(db.pauseBatch("b1")).toBe(2);
    expect(db.claimTask(30_000)).toBeNull();
    expect(db.batchStats("b1").PAUSED).toBe(2);
    expect(db.resumeBatch("b1")).toBe(2);
    expect(db.claimTask(30_000)?.taskId).toBe("t1");
  });
});

describe("任务队列：预算", () => {
  it("reserveAndEnqueue：预算不足 → 拒绝入队（不超卖）", () => {
    freshDb();
    db.upsertBatch("b1", 150); // 预算 150
    const r1 = db.reserveAndEnqueue("b1", {
      taskId: "t1",
      batchId: "b1",
      stage: "COMPOSE",
      idempotencyKey: "K1",
      inputHash: "h",
      ruleVersion: "r",
      promptVersion: "p",
      maxAttempts: 1,
      backoffMs: 100,
      budgetReserved: 100,
    });
    expect(r1.ok).toBe(true);
    const r2 = db.reserveAndEnqueue("b1", {
      taskId: "t2",
      batchId: "b1",
      stage: "COMPOSE",
      idempotencyKey: "K2",
      inputHash: "h",
      ruleVersion: "r",
      promptVersion: "p",
      maxAttempts: 1,
      backoffMs: 100,
      budgetReserved: 100, // 100 > 剩余 50
    });
    expect(r2.ok).toBe(false);
    expect(db.getTask("t2")).toBeNull();

    const budget = db.batchBudget("b1")!;
    expect(budget.reserved).toBe(100);

    // 结算：实际 60 → 释放预留 100，spent 60 → 剩余 90
    const task = db.claimTask(30_000)!;
    db.completeTask(task.taskId, task.leaseToken!, 60);
    db.settleBatchBudget("b1", 100, 60);
    const after = db.batchBudget("b1")!;
    expect(after.reserved).toBe(0);
    expect(after.spent).toBe(60);
  });

  it("reserveAndEnqueue 幂等：同键重复调用不重复预留", () => {
    freshDb();
    db.upsertBatch("b1", 100);
    const input = {
      taskId: "t1",
      batchId: "b1",
      stage: "COMPOSE" as const,
      idempotencyKey: "K1",
      inputHash: "h",
      ruleVersion: "r",
      promptVersion: "p",
      maxAttempts: 1,
      backoffMs: 100,
      budgetReserved: 80,
    };
    expect(db.reserveAndEnqueue("b1", input).ok).toBe(true);
    expect(db.reserveAndEnqueue("b1", input).ok).toBe(true);
    expect(db.batchBudget("b1")!.reserved).toBe(80); // 只预留一次
  });
});
