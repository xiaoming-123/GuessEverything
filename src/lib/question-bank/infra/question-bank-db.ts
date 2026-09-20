/**
 * 智能体题库引擎 · 独立临时 SQLite 存储（P1）
 *
 * 设计稿第 5/6 节：持久化任务队列、稳定身份、不可变发布清单。
 *
 * 隔离约束（任务书红线）：
 * - 仅打开调用方给定的**临时**数据库文件（:memory: 或临时路径），
 *   绝不连接真实游戏库、绝不读写 prisma/schema.prisma 生成的正式库。
 * - 不引入外部服务；仅用 Node 内置 node:sqlite（Node >= 22.13，当前 24）。
 * - 单节点、短事务；租约领取用 IMMEDIATE 事务保证原子性。
 *
 * 时钟注入：所有「当前时间」来自可注入的 nowMs()，便于测试
 * 验证租约过期、退避到期、崩溃恢复（不依赖真实等待）。
 */

import { DatabaseSync } from "node:sqlite";
import {
  transitionCandidate,
  transitionTask,
} from "../contracts/state-machine";
import { faceFingerprint } from "../validators/rules";
import type {
  ActiveRelease,
  CandidateStatus,
  QuestionVersion,
  ReleaseAuditEntry,
  ReleaseItem,
  SourceEntry,
  SourceSnapshot,
  TaskRecord,
  TaskStage,
  TaskStatus,
  Work,
  WorkVersion,
} from "../contracts/types";

/** 时间戳统一为 epoch 毫秒（DB 内 INTEGER），对外映射 ISO 字符串 */
const toIso = (ms: number) => new Date(ms).toISOString();

/** 生成租约令牌（确定性可测：注入计数器，否则时间+随机） */
export function makeLeaseToken(seed: string): string {
  // 简单可逆散列，避免引入额外依赖；令牌只需唯一
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `lease-${(h >>> 0).toString(16)}-${seed}`;
}

export class QuestionBankDb {
  private readonly db: DatabaseSync;
  private readonly nowMs: () => number;
  private readonly ownDb: boolean;

  constructor(filename: string, opts: { nowMs?: () => number } = {}) {
    this.ownDb = true;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(CANDIDATE_SCHEMA);
    this.db.exec(QUEUE_SCHEMA);
  }

  /** 关闭底层连接（测试/CLI 结束调用） */
  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已回滚 */
      }
      throw e;
    }
  }

  /* ============================ 任务队列 ============================ */

  /** 入队（幂等：同 idempotencyKey 已存在则直接返回既有任务，不重复创建） */
  enqueueTask(input: {
    taskId: string;
    batchId: string;
    stage: TaskStage;
    idempotencyKey: string;
    inputHash: string;
    ruleVersion: string;
    promptVersion: string;
    maxAttempts: number;
    backoffMs: number;
    budgetReserved: number;
    /** 结构化输入载荷（阶段处理参数；仅数据，不含指令） */
    inputPayload?: Record<string, unknown>;
  }): TaskRecord {
    const now = this.nowMs();
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (
            task_id, batch_id, stage, idempotency_key, input_hash,
            rule_version, prompt_version, status, attempt,
            lease_token, lease_until, max_attempts, backoff_ms,
            available_at, budget_reserved, budget_used,
            input_payload, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,0,
            NULL,NULL,?,?,?,?,0,?,?,?)
          ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          input.taskId,
          input.batchId,
          input.stage,
          input.idempotencyKey,
          input.inputHash,
          input.ruleVersion,
          input.promptVersion,
          "QUEUED",
          input.maxAttempts,
          input.backoffMs,
          now,
          input.budgetReserved,
          JSON.stringify(input.inputPayload ?? {}),
          now,
          now,
        );
      const row = this.db
        .prepare("SELECT * FROM tasks WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as unknown as TaskRow;
      return this.mapTask(row);
    });
  }

  /**
   * 预留批次预算并入队（单事务，避免超卖）。
   * 预算不足 → 不入队并返回原因（调度层据此暂停批次）。
   */
  reserveAndEnqueue(
    batchId: string,
    input: Parameters<QuestionBankDb["enqueueTask"]>[0],
  ): { ok: true; task: TaskRecord } | { ok: false; reason: string } {
    return this.tx(() => {
      // 幂等先行：任务已存在 → 直接返回，不重复预留预算
      const dup = this.db
        .prepare("SELECT * FROM tasks WHERE idempotency_key=?")
        .get(input.idempotencyKey) as unknown as TaskRow | undefined;
      if (dup) return { ok: true, task: this.mapTask(dup) };

      const row = this.db
        .prepare("SELECT * FROM batches WHERE batch_id=?")
        .get(batchId) as
        | { budget_token: number; budget_reserved: number; budget_spent: number }
        | undefined;
      if (!row) return { ok: false, reason: `批次 ${batchId} 不存在` };
      const remaining = row.budget_token - row.budget_reserved - row.budget_spent;
      if (input.budgetReserved > remaining) {
        return {
          ok: false,
          reason: `批次预算不足：需预留 ${input.budgetReserved}，剩余 ${remaining}`,
        };
      }
      this.db
        .prepare("UPDATE batches SET budget_reserved = budget_reserved + ? WHERE batch_id=?")
        .run(input.budgetReserved, batchId);
      this.db
        .prepare(
          `INSERT INTO tasks (
            task_id, batch_id, stage, idempotency_key, input_hash,
            rule_version, prompt_version, status, attempt,
            lease_token, lease_until, max_attempts, backoff_ms,
            available_at, budget_reserved, budget_used,
            input_payload, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,0,
            NULL,NULL,?,?,?,?,0,?,?,?)
          ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          input.taskId,
          input.batchId,
          input.stage,
          input.idempotencyKey,
          input.inputHash,
          input.ruleVersion,
          input.promptVersion,
          "QUEUED",
          input.maxAttempts,
          input.backoffMs,
          this.nowMs(),
          input.budgetReserved,
          JSON.stringify(input.inputPayload ?? {}),
          this.nowMs(),
          this.nowMs(),
        );
      const taskRow = this.db
        .prepare("SELECT * FROM tasks WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as unknown as TaskRow;
      return { ok: true, task: this.mapTask(taskRow) };
    });
  }

  /**
   * 原子领取租约：
   * - 取最早可领（status ∈ QUEUED/RETRY_WAIT 且 available_at <= now）的一条；
   * - 在同一 IMMEDIATE 事务内 SELECT + 条件 UPDATE（status 守卫），
   *   并发只有一个 worker 能把该行从 QUEUED 翻成 RUNNING；
   * - 生成全新 leaseToken，lease_until = now + leaseMs。
   * 无可领 → 返回 null。
   */
  claimTask(
    leaseMs: number,
    opts: { nowMs?: number } = {},
  ): TaskRecord | null {
    const now = opts.nowMs ?? this.nowMs();
    return this.tx(() => {
      // PUBLISH 门控：批次内仍有未完结的非发布任务时，发布任务暂不可领。
      // 确保清单包含批次「全部」已批准题，而非首个 REVIEW 完成时的快照。
      const cand = this.db
        .prepare(
          `SELECT task_id FROM tasks
           WHERE status IN ('QUEUED','RETRY_WAIT') AND available_at <= ?
             AND NOT (
               stage = 'PUBLISH'
               AND EXISTS (
                 SELECT 1 FROM tasks t2
                 WHERE t2.batch_id = tasks.batch_id
                   AND t2.task_id <> tasks.task_id
                   AND t2.stage <> 'PUBLISH'
                   AND t2.status IN ('QUEUED','RUNNING','RETRY_WAIT','PAUSED')
               )
             )
           ORDER BY available_at ASC, task_id ASC LIMIT 1`,
        )
        .get(now) as { task_id: string } | undefined;
      if (!cand) return null;
      const token = makeLeaseToken(`${cand.task_id}:${now}:${Math.random()}`);
      const res = this.db
        .prepare(
          `UPDATE tasks SET status='RUNNING', attempt = attempt + 1,
             lease_token=?, lease_until=?, updated_at=?
           WHERE task_id=? AND status IN ('QUEUED','RETRY_WAIT')`,
        )
        .run(token, now + leaseMs, now, cand.task_id);
      if (Number(res.changes) === 0) return null; // 并发已被他人领取
      const row = this.db
        .prepare("SELECT * FROM tasks WHERE task_id = ?")
        .get(cand.task_id) as unknown as TaskRow;
      return this.mapTask(row);
    });
  }

  /** 心跳续租：仅当 lease_token 仍匹配且仍 RUNNING 才有效 */
  heartbeat(taskId: string, leaseToken: string): boolean {
    const now = this.nowMs();
    const res = this.db
      .prepare(
        `UPDATE tasks SET lease_until = ?, updated_at = ?
         WHERE task_id=? AND lease_token=? AND status='RUNNING'`,
      )
      .run(now + this.defaultLeaseMs(), now, taskId, leaseToken);
    return res.changes === 1;
  }

  /** 提交成功：必须匹配最新 leaseToken（旧 worker 迟到结果 → 拒绝） */
  completeTask(taskId: string, leaseToken: string, budgetUsed: number): boolean {
    const now = this.nowMs();
    return this.tx(() => {
      const res = this.db
        .prepare(
          `UPDATE tasks SET status='SUCCEEDED', budget_used=?,
             lease_token=NULL, lease_until=NULL, updated_at=?
           WHERE task_id=? AND lease_token=? AND status='RUNNING'`,
        )
        .run(budgetUsed, now, taskId, leaseToken);
      return res.changes === 1;
    });
  }

  /**
   * 提交失败（决定后续状态）。
   * - leaseToken 不匹配 / 已非 RUNNING → 拒绝（返回 false，迟到结果丢弃）。
   * - 匹配 → 按 kind 与 attempt 决定 RETRY_WAIT / FAILED / PAUSED。
   */
  failTask(
    taskId: string,
    leaseToken: string,
    error: { kind: "TRANSIENT" | "PERMANENT"; message: string },
    opts: { pause?: boolean } = {},
  ): { accepted: boolean; newStatus: TaskStatus | null } {
    const now = this.nowMs();
    return this.tx(() => {
      const row = this.db
        .prepare("SELECT * FROM tasks WHERE task_id=?")
        .get(taskId) as unknown as TaskRow | undefined;
      if (!row) return { accepted: false, newStatus: null };
      if (row.status !== "RUNNING" || row.lease_token !== leaseToken) {
        return { accepted: false, newStatus: null }; // 旧租约迟到结果
      }

      let next: TaskStatus;
      let availableAt = now;
      if (opts.pause) {
        next = "PAUSED";
      } else if (error.kind === "PERMANENT") {
        next = "FAILED";
      } else if (row.attempt >= row.max_attempts) {
        next = "FAILED";
      } else {
        next = "RETRY_WAIT";
        availableAt = now + row.backoff_ms;
      }
      transitionTask("RUNNING", next); // 状态机守卫

      this.db
        .prepare(
          `UPDATE tasks SET status=?, available_at=?,
             last_error_kind=?, last_error_message=?,
             lease_token=NULL, lease_until=NULL, updated_at=?
           WHERE task_id=?`,
        )
        .run(next, availableAt, error.kind, error.message, now, taskId);
      return { accepted: true, newStatus: next };
    });
  }

  /**
   * 过期重领（崩溃恢复）：RUNNING 且 lease_until < now 的任务
   * 重置回 QUEUED（保留 attempt），可被新 worker 重新领取。
   * 返回被回收的 taskId 列表。
   */
  reclaimExpired(nowMs?: number): string[] {
    const now = nowMs ?? this.nowMs();
    return this.tx(() => {
      const expired = this.db
        .prepare(
          `SELECT task_id FROM tasks
           WHERE status='RUNNING' AND lease_until IS NOT NULL AND lease_until < ?`,
        )
        .all(now) as Array<{ task_id: string }>;
      for (const { task_id } of expired) {
        this.db
          .prepare(
            `UPDATE tasks SET status='QUEUED', lease_token=NULL, lease_until=NULL,
               available_at=?, updated_at=?
             WHERE task_id=? AND status='RUNNING'`,
          )
          .run(now, now, task_id);
      }
      return expired.map((e) => e.task_id);
    });
  }

  /** 暂停批次（RUNNING/QUEUED/RETRY_WAIT → PAUSED） */
  pauseBatch(batchId: string): number {
    const now = this.nowMs();
    return this.tx(() => {
      const res = this.db
        .prepare(
          `UPDATE tasks SET status='PAUSED', updated_at=?
           WHERE batch_id=? AND status IN ('QUEUED','RUNNING','RETRY_WAIT')`,
        )
        .run(now, batchId);
      return Number(res.changes);
    });
  }

  /** 恢复批次（PAUSED → QUEUED，立即可领） */
  resumeBatch(batchId: string): number {
    const now = this.nowMs();
    return this.tx(() => {
      const res = this.db
        .prepare(
          `UPDATE tasks SET status='QUEUED', available_at=?, updated_at=?
           WHERE batch_id=? AND status='PAUSED'`,
        )
        .run(now, now, batchId);
      return Number(res.changes);
    });
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE task_id=?")
      .get(taskId) as unknown as TaskRow | undefined;
    return row ? this.mapTask(row) : null;
  }

  /** 任务输入载荷（阶段处理参数） */
  getTaskPayload(taskId: string): Record<string, unknown> {
    const row = this.db
      .prepare("SELECT input_payload FROM tasks WHERE task_id=?")
      .get(taskId) as { input_payload: string } | undefined;
    if (!row) return {};
    return JSON.parse(row.input_payload) as Record<string, unknown>;
  }

  /**
   * 批次预算耗尽（余额 <= 0）时，调度层据此把未完成任务转入 PAUSED
   * （设计稿第 6 节：耗尽进入 PAUSED 并报告已完成部分，不能无限重试）。
   */
  pauseUnfinishedByBatch(batchId: string): number {
    const now = this.nowMs();
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='PAUSED', lease_token=NULL, lease_until=NULL,
           updated_at=?
         WHERE batch_id=? AND status IN ('QUEUED','RETRY_WAIT','PAUSED')`,
      )
      .run(now, batchId);
    return Number(res.changes);
  }

  listTasks(batchId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE batch_id=? ORDER BY task_id")
      .all(batchId) as unknown as TaskRow[];
    return rows.map((r) => this.mapTask(r));
  }

  /** 批次状态统计（报表/恢复判定用） */
  batchStats(batchId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) c FROM tasks WHERE batch_id=? GROUP BY status",
      )
      .all(batchId) as Array<{ status: string; c: number }>;
    const out: Record<string, number> = {
      QUEUED: 0, RUNNING: 0, RETRY_WAIT: 0, SUCCEEDED: 0, FAILED: 0, PAUSED: 0,
    };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  /* ============================ 发布清单 ============================ */

  /**
   * 写入不可变发布清单（批次幂等：同 batch_key 已存在 → 幂等返回既有，
   * 绝不产生第二份发布）。
   * 验收门控：acceptance.ok=false → 拒绝写入并记 REJECTED 审计。
   */
  upsertRelease(input: {
    releaseId: string;
    batchId: string;
    batchKey: string;
    ruleVersion: string;
    items: ReleaseItem[];
    manifestHash: string;
    acceptance: { ok: boolean; issues: string[] };
    createdAt: string;
  }): { releaseId: string; created: boolean } | { ok: false; reason: string } {
    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT release_id FROM releases WHERE batch_key=?")
        .get(input.batchKey) as { release_id: string } | undefined;
      if (existing) return { releaseId: existing.release_id, created: false };
      if (!input.acceptance.ok) {
        this.db
          .prepare(
            `INSERT INTO release_audit (audit_id, release_id, action, detail, created_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(audit_id) DO NOTHING`,
          )
          .run(
            `${input.releaseId}:rejected`,
            input.releaseId,
            "REJECTED",
            `验收未通过：${input.acceptance.issues.join("; ")}`,
            input.createdAt,
          );
        return {
          ok: false,
          reason: `验收未通过：${input.acceptance.issues.join("; ")}`,
        };
      }
      this.db
        .prepare(
          `INSERT INTO releases (release_id, batch_id, batch_key, rule_version,
             items, manifest_hash, acceptance, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.releaseId,
          input.batchId,
          input.batchKey,
          input.ruleVersion,
          JSON.stringify(input.items),
          input.manifestHash,
          JSON.stringify(input.acceptance),
          input.createdAt,
        );
      this.db
        .prepare(
          `INSERT INTO release_audit (audit_id, release_id, action, detail, created_at)
           VALUES (?,?,?,?,?)`,
        )
        .run(`${input.releaseId}:created`, input.releaseId, "CREATED", "清单创建", input.createdAt);
      return { releaseId: input.releaseId, created: true };
    });
  }

  getRelease(releaseId: string): {
    releaseId: string;
    batchKey: string;
    ruleVersion: string;
    items: ReleaseItem[];
    manifestHash: string;
    createdAt: string;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM releases WHERE release_id=?")
      .get(releaseId) as
      | {
          release_id: string;
          batch_key: string;
          rule_version: string;
          items: string;
          manifest_hash: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      releaseId: row.release_id,
      batchKey: row.batch_key,
      ruleVersion: row.rule_version,
      items: JSON.parse(row.items) as ReleaseItem[],
      manifestHash: row.manifest_hash,
      createdAt: row.created_at,
    };
  }

  getReleaseByBatchKey(batchKey: string): { releaseId: string; manifestHash: string } | null {
    const row = this.db
      .prepare("SELECT release_id, manifest_hash FROM releases WHERE batch_key=?")
      .get(batchKey) as { release_id: string; manifest_hash: string } | undefined;
    return row
      ? { releaseId: row.release_id, manifestHash: row.manifest_hash }
      : null;
  }

  /**
   * 原子激活：比较旧指针后切换（expectedPrevious 不匹配 → 拒绝，防并发覆盖）。
   * 回滚 = 用本函数把指针切回先前 release。
   */
  activateRelease(
    releaseId: string,
    expectedPrevious: string | null,
    nowIso: string,
  ): { ok: true; previous: string | null } | { ok: false; reason: string } {
    return this.tx(() => {
      const rel = this.db
        .prepare("SELECT release_id FROM releases WHERE release_id=?")
        .get(releaseId);
      if (!rel) return { ok: false, reason: `发布 ${releaseId} 不存在` };

      const cur = this.db
        .prepare("SELECT release_id, previous_release_id FROM active_release WHERE id=1")
        .get() as { release_id: string | null; previous_release_id: string | null } | undefined;
      const current = cur?.release_id ?? null;
      if (current !== expectedPrevious) {
        return {
          ok: false,
          reason: `指针已变更：期望 ${expectedPrevious ?? "null"}，实际 ${current ?? "null"}`,
        };
      }
      this.db
        .prepare(
          `INSERT INTO active_release (id, release_id, activated_at, previous_release_id)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             release_id=excluded.release_id,
             activated_at=excluded.activated_at,
             previous_release_id=excluded.previous_release_id`,
        )
        .run(releaseId, nowIso, current);
      this.db
        .prepare(
          `INSERT INTO release_audit (audit_id, release_id, action, detail, created_at)
           VALUES (?,?,?,?,?)`,
        )
        .run(
          `${releaseId}:activated:${nowIso}`,
          releaseId,
          "ACTIVATED",
          `从 ${current ?? "null"} 切换`,
          nowIso,
        );
      return { ok: true, previous: current };
    });
  }

  getActiveRelease(): ActiveRelease | null {
    const row = this.db
      .prepare("SELECT * FROM active_release WHERE id=1")
      .get() as
      | {
          release_id: string | null;
          activated_at: string | null;
          previous_release_id: string | null;
        }
      | undefined;
    if (!row || !row.release_id) return null;
    return {
      releaseId: row.release_id,
      activatedAt: row.activated_at ?? "",
      previousReleaseId: row.previous_release_id,
    };
  }

  /**
   * 回滚：把激活指针原子切回先前清单（设计稿第 7 节：
   * 回滚只切回先前清单，不删除清单与玩家记录）。
   * - 仅当当前指针确实是 `current` 时生效（compare-and-swap）；
   * - `to` 必须是已存在的清单（且不得等于 current）。
   */
  rollbackRelease(
    current: string | null,
    to: string | null,
    nowIso: string,
  ):
    | { ok: true; previous: string | null; target: string | null }
    | { ok: false; reason: string } {
    if (to === current) {
      return { ok: false, reason: `回滚目标与当前指针相同（${to ?? "null"}）` };
    }
    // 回滚目标为 null（清空激活指针）：直接 CAS 更新，不经 activateRelease
    if (to === null) {
      return this.tx(() => {
        const cur = this.db
          .prepare("SELECT release_id FROM active_release WHERE id=1")
          .get() as { release_id: string | null } | undefined;
        const currentPtr = cur?.release_id ?? null;
        if (currentPtr !== current) {
          return {
            ok: false,
            reason: `指针已变更：期望 ${current ?? "null"}，实际 ${currentPtr ?? "null"}`,
          };
        }
        this.db
          .prepare(
            `INSERT INTO active_release (id, release_id, activated_at, previous_release_id)
             VALUES (1, NULL, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               release_id=excluded.release_id,
               activated_at=excluded.activated_at,
               previous_release_id=excluded.previous_release_id`,
          )
          .run(nowIso, currentPtr);
        this.db
          .prepare(
            `INSERT INTO release_audit (audit_id, release_id, action, detail, created_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(audit_id) DO NOTHING`,
          )
          .run(
            `rollback-to-null:${nowIso}`,
            currentPtr ?? "null",
            "ROLLBACK",
            `从 ${currentPtr ?? "null"} 回滚至无激活清单`,
            nowIso,
          );
        return { ok: true, previous: currentPtr, target: null };
      });
    }
    const rel = this.db
      .prepare("SELECT release_id FROM releases WHERE release_id=?")
      .get(to);
    if (!rel) return { ok: false, reason: `回滚目标 ${to} 不存在` };
    const res = this.activateRelease(to, current, nowIso);
    if (!res.ok) return res;
    this.db
      .prepare(
        `INSERT INTO release_audit (audit_id, release_id, action, detail, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(audit_id) DO NOTHING`,
      )
      .run(
        `${to}:rollback:${nowIso}`,
        to,
        "ROLLBACK",
        `回滚至 ${to}（原指针 ${current ?? "null"}）`,
        nowIso,
      );
    return { ok: true, previous: res.previous, target: to };
  }

  releaseAudit(releaseId: string): ReleaseAuditEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM release_audit WHERE release_id=? ORDER BY created_at")
      .all(releaseId) as Array<{
        audit_id: string;
        release_id: string;
        action: string;
        detail: string;
        created_at: string;
      }>;
    return rows.map((r) => ({
      auditId: r.audit_id,
      releaseId: r.release_id,
      action: r.action as ReleaseAuditEntry["action"],
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  /* ============================ 批次预算 ============================ */

  /** 创建批次（幂等：同 batch_id 已存在 → 返回既有） */
  upsertBatch(batchId: string, tokenBudget: number): void {
    const now = this.nowMs();
    this.db
      .prepare(
        `INSERT INTO batches (batch_id, created_at, budget_token)
         VALUES (?,?,?)
         ON CONFLICT(batch_id) DO NOTHING`,
      )
      .run(batchId, now, tokenBudget);
  }

  /**
   * 批次预算结算（任务完成/失败后调用）：
   * - released：从 reserved 中释放（成功/失败均释放预留）
   * - spent：实际消耗加入 spent
   * 余额 = budget_token − budget_reserved − budget_spent。
   */
  settleBatchBudget(batchId: string, released: number, spent: number): void {
    this.db
      .prepare(
        `UPDATE batches SET
           budget_reserved = MAX(0, budget_reserved - ?),
           budget_spent = budget_spent + ?
         WHERE batch_id=?`,
      )
      .run(released, spent, batchId);
  }

  /** 批次预算预留（入队前调用；不足返回 false） */
  reserveBatchBudget(batchId: string, amount: number): boolean {
    return this.tx(() => {
      const row = this.db
        .prepare("SELECT * FROM batches WHERE batch_id=?")
        .get(batchId) as
        | { budget_token: number; budget_reserved: number; budget_spent: number }
        | undefined;
      if (!row) return false;
      const remaining = row.budget_token - row.budget_reserved - row.budget_spent;
      if (amount > remaining) return false;
      this.db
        .prepare(
          "UPDATE batches SET budget_reserved = budget_reserved + ? WHERE batch_id=?",
        )
        .run(amount, batchId);
      return true;
    });
  }

  batchBudget(batchId: string): {
    tokenBudget: number;
    reserved: number;
    spent: number;
  } | null {
    const row = this.db
      .prepare(
        "SELECT budget_token, budget_reserved, budget_spent FROM batches WHERE batch_id=?",
      )
      .get(batchId) as
      | { budget_token: number; budget_reserved: number; budget_spent: number }
      | undefined;
    if (!row) return null;
    return {
      tokenBudget: row.budget_token,
      reserved: row.budget_reserved,
      spent: row.budget_spent,
    };
  }

  /* ============================ 候选区 ============================ */

  /** 登记来源（幂等 upsert） */
  upsertSource(source: SourceEntry): void {
    this.db
      .prepare(
        `INSERT INTO sources (source_id, type, uri, license, version_strategy,
           allowed_use, enabled)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(source_id) DO UPDATE SET
           type=excluded.type, uri=excluded.uri, license=excluded.license,
           version_strategy=excluded.version_strategy,
           allowed_use=excluded.allowed_use, enabled=excluded.enabled`,
      )
      .run(
        source.sourceId,
        source.type,
        source.uri,
        source.license,
        source.versionStrategy,
        JSON.stringify(source.allowedUse),
        source.enabled ? 1 : 0,
      );
  }

  getSource(sourceId: string): SourceEntry | null {
    const row = this.db
      .prepare("SELECT * FROM sources WHERE source_id=?")
      .get(sourceId) as
      | {
          source_id: string;
          type: string;
          uri: string;
          license: string;
          version_strategy: string;
          allowed_use: string;
          enabled: number;
        }
      | undefined;
    if (!row) return null;
    return {
      sourceId: row.source_id,
      type: row.type as SourceEntry["type"],
      uri: row.uri,
      license: row.license,
      versionStrategy: row.version_strategy as SourceEntry["versionStrategy"],
      allowedUse: JSON.parse(row.allowed_use) as SourceEntry["allowedUse"],
      enabled: row.enabled === 1,
    };
  }

  /** 幂等登记快照：同 (sourceId, revision, contentHash) 已存在 → 返回既有 id */
  saveSnapshot(snapshot: SourceSnapshot): { snapshotId: string; created: boolean } {
    return this.tx(() => {
      const existing = this.db
        .prepare(
          "SELECT snapshot_id FROM snapshots WHERE source_id=? AND revision=? AND content_hash=?",
        )
        .get(snapshot.sourceId, snapshot.revision, snapshot.contentHash) as
        | { snapshot_id: string }
        | undefined;
      if (existing) return { snapshotId: existing.snapshot_id, created: false };
      this.db
        .prepare(
          `INSERT INTO snapshots (snapshot_id, source_id, revision, captured_at,
             content_hash, evidence_path, raw_text, normalized_text, converter_version)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          snapshot.snapshotId,
          snapshot.sourceId,
          snapshot.revision,
          snapshot.capturedAt,
          snapshot.contentHash,
          snapshot.evidencePath,
          snapshot.rawText,
          snapshot.normalizedText,
          snapshot.converterVersion,
        );
      return { snapshotId: snapshot.snapshotId, created: true };
    });
  }

  getSnapshot(snapshotId: string): SourceSnapshot | null {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE snapshot_id=?")
      .get(snapshotId) as
      | {
          snapshot_id: string;
          source_id: string;
          revision: string;
          captured_at: string;
          content_hash: string;
          evidence_path: string;
          raw_text: string;
          normalized_text: string;
          converter_version: string;
        }
      | undefined;
    if (!row) return null;
    return {
      snapshotId: row.snapshot_id,
      sourceId: row.source_id,
      revision: row.revision,
      capturedAt: row.captured_at,
      contentHash: row.content_hash,
      evidencePath: row.evidence_path,
      rawText: row.raw_text,
      normalizedText: row.normalized_text,
      converterVersion: row.converter_version,
    };
  }

  /** 登记作品身份（幂等 upsert；currentVersionId 同步更新） */
  upsertWork(work: Work): void {
    this.db
      .prepare(
        `INSERT INTO works (work_id, author_canonical, title_canonical, dynasty,
           verification_status, author_aliases, title_aliases, current_version_id)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(work_id) DO UPDATE SET
           author_canonical=excluded.author_canonical,
           title_canonical=excluded.title_canonical,
           dynasty=excluded.dynasty,
           verification_status=excluded.verification_status,
           author_aliases=excluded.author_aliases,
           title_aliases=excluded.title_aliases,
           current_version_id=excluded.current_version_id`,
      )
      .run(
        work.workId,
        work.authorCanonical,
        work.titleCanonical,
        work.dynasty,
        work.verificationStatus,
        JSON.stringify(work.authorAliases),
        JSON.stringify(work.titleAliases),
        work.currentVersionId,
      );
  }

  getWork(workId: string): Work | null {
    const row = this.db
      .prepare("SELECT * FROM works WHERE work_id=?")
      .get(workId) as unknown as Parameters<typeof this.mapWorkRow>[0] | undefined;
    if (!row) return null;
    return this.mapWorkRow(row);
  }

  /** 登记作品版本（幂等：同 id 已存在 → 不覆盖） */
  saveWorkVersion(wv: WorkVersion): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO work_versions (work_version_id, work_id, version, title,
           author, lines, content_hash, evidence, notes)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(work_version_id) DO NOTHING`,
      )
      .run(
        wv.workVersionId,
        wv.workId,
        wv.version,
        wv.title,
        wv.author,
        JSON.stringify(wv.lines),
        wv.contentHash,
        JSON.stringify(wv.evidence),
        wv.notes ?? null,
      );
    return Number(res.changes) === 1;
  }

  getWorkVersion(workVersionId: string): WorkVersion | null {
    const row = this.db
      .prepare("SELECT * FROM work_versions WHERE work_version_id=?")
      .get(workVersionId) as
      | {
          work_version_id: string;
          work_id: string;
          version: number;
          title: string;
          author: string;
          lines: string;
          content_hash: string;
          evidence: string;
          notes: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      workVersionId: row.work_version_id,
      workId: row.work_id,
      version: row.version,
      title: row.title,
      author: row.author,
      lines: JSON.parse(row.lines) as string[],
      contentHash: row.content_hash,
      evidence: JSON.parse(row.evidence) as WorkVersion["evidence"],
      notes: row.notes ?? undefined,
    };
  }

  /** 列出全部作品（干扰项池构建/报表用） */
  listWorks(): Work[] {
    const rows = this.db
      .prepare("SELECT * FROM works ORDER BY work_id")
      .all() as unknown[];
    return rows.map(
      (r) => this.mapWorkRow(r as unknown as Parameters<typeof this.mapWorkRow>[0]),
    );
  }

  private mapWorkRow(row: {
    work_id: string;
    author_canonical: string;
    title_canonical: string;
    dynasty: string;
    verification_status: string;
    author_aliases: string;
    title_aliases: string;
    current_version_id: string | null;
  }): Work {
    return {
      workId: row.work_id,
      authorCanonical: row.author_canonical,
      titleCanonical: row.title_canonical,
      dynasty: row.dynasty,
      verificationStatus: row.verification_status as Work["verificationStatus"],
      authorAliases: JSON.parse(row.author_aliases) as string[],
      titleAliases: JSON.parse(row.title_aliases) as string[],
      currentVersionId: row.current_version_id ?? "",
    };
  }

  /* ------------------------- 候选题版本 ------------------------- */

  /** 题面指纹（去重锚点） */
  private computeFace(
    type: QuestionVersion["type"],
    prompt: string,
    correct: string | null,
  ): string {
    return faceFingerprint(type, prompt, correct ?? "");
  }

  /** 保存候选题版本（幂等：同 question_id+version 已存在 → 拒绝覆盖） */
  saveQuestionVersion(v: QuestionVersion): { saved: boolean; reason?: string } {
    const now = this.nowMs();
    return this.tx(() => {
      const existing = this.db
        .prepare(
          "SELECT question_id FROM question_versions WHERE question_id=? AND version=?",
        )
        .get(v.questionId, v.version) as { question_id: string } | undefined;
      if (existing) {
        return { saved: false, reason: `版本已存在: ${v.questionId} v${v.version}` };
      }
      const correct =
        v.options[v.options.indexOf(v.correctOptionId)] ?? null;
      this.db
        .prepare(
          `INSERT INTO question_versions (question_id, version, type, prompt,
             options, correct_option_id, evidence, work_version_id,
             content_hash, status, face_fingerprint, revision_round,
             created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          v.questionId,
          v.version,
          v.type,
          v.prompt,
          JSON.stringify(v.options),
          v.correctOptionId,
          JSON.stringify(v.evidence),
          v.workVersionId,
          v.contentHash,
          v.status,
          this.computeFace(v.type, v.prompt, correct),
          v.status === "NEEDS_REVISION" ? 1 : 0,
          now,
          now,
        );
      return { saved: true };
    });
  }

  private mapQuestionRow(row: {
    question_id: string;
    version: number;
    type: string;
    prompt: string;
    options: string;
    correct_option_id: string;
    evidence: string;
    work_version_id: string;
    content_hash: string;
    status: string;
    revision_round: number;
  }): QuestionVersion {
    return {
      questionId: row.question_id,
      version: row.version,
      type: row.type as QuestionVersion["type"],
      prompt: row.prompt,
      options: JSON.parse(row.options) as QuestionVersion["options"],
      correctOptionId: row.correct_option_id,
      evidence: JSON.parse(row.evidence) as QuestionVersion["evidence"],
      workVersionId: row.work_version_id,
      contentHash: row.content_hash,
      status: row.status as CandidateStatus,
      difficultyHint: undefined,
      revisionRound: row.revision_round,
    };
  }

  getQuestionVersion(
    questionId: string,
    version: number,
  ): QuestionVersion | null {
    const row = this.db
      .prepare(
        "SELECT * FROM question_versions WHERE question_id=? AND version=?",
      )
      .get(questionId, version) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapQuestionRow(row as unknown as Parameters<typeof this.mapQuestionRow>[0]);
  }

  /** 按状态列出候选题版本（发布收集用；有序，保证清单确定） */
  listQuestionVersions(status?: CandidateStatus): QuestionVersion[] {
    const rows = status
      ? (this.db
          .prepare(
            "SELECT * FROM question_versions WHERE status=? ORDER BY question_id, version",
          )
          .all(status) as unknown[])
      : (this.db
          .prepare(
            "SELECT * FROM question_versions ORDER BY question_id, version",
          )
          .all() as unknown[]);
    return rows.map(
      (r) =>
        this.mapQuestionRow(
          r as unknown as Parameters<typeof this.mapQuestionRow>[0],
        ),
    );
  }

  /** 取知识点当前最高版本 */
  getLatestQuestionVersion(questionId: string): QuestionVersion | null {
    const row = this.db
      .prepare(
        "SELECT * FROM question_versions WHERE question_id=? ORDER BY version DESC LIMIT 1",
      )
      .get(questionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const anyRow = row as { question_id: string; version: number };
    return this.getQuestionVersion(anyRow.question_id, anyRow.version);
  }

  /** 状态迁移（带状态机守卫 + 版本绑定守卫：contentHash 必须匹配） */
  transitionQuestionVersion(
    questionId: string,
    version: number,
    to: CandidateStatus,
    expectedContentHash: string,
  ): { ok: boolean; reason?: string } {
    return this.tx(() => {
      const cur = this.getQuestionVersion(questionId, version);
      if (!cur) return { ok: false, reason: `版本不存在: ${questionId} v${version}` };
      if (cur.contentHash !== expectedContentHash) {
        return {
          ok: false,
          reason: `内容哈希不匹配（版本已被修改，迁移基于过期状态）：期望 ${expectedContentHash}，实际 ${cur.contentHash}`,
        };
      }
      transitionCandidate(cur.status, to); // 状态机守卫（非法迁移抛错）
      const now = this.nowMs();
      this.db
        .prepare(
          `UPDATE question_versions SET status=?, updated_at=?
           WHERE question_id=? AND version=? AND content_hash=?`,
        )
        .run(to, now, questionId, version, expectedContentHash);
      return { ok: true };
    });
  }

  /**
   * 批量：已存在的题面指纹集合（跨批次/跨知识点去重用）。
   * 题面（type+题干+正确答案）由知识点身份决定，修订只换选项、题面不变，
   * 故按 questionId 排除「该知识点的所有版本」——否则修订版本会与自身前版
   * 误报 DUPLICATE_FACE。仅不同知识点的同题面才应触发去重。
   */
  existingFaceFingerprints(exclude?: { questionId: string }): Set<string> {
    if (exclude) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT face_fingerprint FROM question_versions
           WHERE question_id <> ?`,
        )
        .all(exclude.questionId) as Array<{ face_fingerprint: string }>;
      return new Set(rows.map((r) => r.face_fingerprint));
    }
    const rows = this.db
      .prepare(
        "SELECT DISTINCT face_fingerprint FROM question_versions",
      )
      .all() as Array<{ face_fingerprint: string }>;
    return new Set(rows.map((r) => r.face_fingerprint));
  }

  /**
   * 批量：已存在 questionId → 最高版本（知识点去重用）。
   * 须排除「当前版本自身」，否则重跑校验会自误报 DUPLICATE_QUESTION_ID。
   */
  existingQuestionIds(
    exclude?: { questionId: string; version: number },
  ): Map<string, number> {
    const rows = exclude
      ? (this.db
          .prepare(
            `SELECT question_id, MAX(version) v FROM question_versions
             WHERE NOT (question_id=? AND version=?)
             GROUP BY question_id`,
          )
          .all(exclude.questionId, exclude.version) as Array<{ question_id: string; v: number }>)
      : (this.db
          .prepare(
            "SELECT question_id, MAX(version) v FROM question_versions GROUP BY question_id",
          )
          .all() as Array<{ question_id: string; v: number }>);
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.question_id, r.v);
    return m;
  }

  /* ----------------------------- 审核 ----------------------------- */

  /** 写入审核记录（幂等：同 review_id 已存在 → 拒绝） */
  saveReview(r: {
    reviewId: string;
    questionId: string;
    questionVersion: number;
    inputHash: string;
    role: string;
    modelVersion: string;
    independentAnswer: string;
    issues: Array<{ code: string; message: string; location?: string }>;
    verdict: "PASS" | "REJECT" | "NEEDS_VERIFICATION";
    createdAt: string;
  }): { saved: boolean; reason?: string } {
    const res = this.db
      .prepare(
        `INSERT INTO reviews (review_id, question_id, question_version,
           input_hash, role, model_version, independent_answer, issues,
           verdict, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(review_id) DO NOTHING`,
      )
      .run(
        r.reviewId,
        r.questionId,
        r.questionVersion,
        r.inputHash,
        r.role,
        r.modelVersion,
        r.independentAnswer,
        JSON.stringify(r.issues),
        r.verdict,
        r.createdAt,
      );
    return Number(res.changes) === 1
      ? { saved: true }
      : { saved: false, reason: `reviewId 已存在: ${r.reviewId}` };
  }

  /**
   * 取「与当前版本内容哈希一致」的最新通过审核（审核版本绑定核心）：
   * input_hash 必须等于该版本的 content_hash，否则旧审核一律视为失效。
   */
  getLatestPassReview(
    questionId: string,
    version: number,
  ): {
    reviewId: string;
    inputHash: string;
    verdict: string;
    createdAt: string;
  } | null {
    const cur = this.getQuestionVersion(questionId, version);
    if (!cur) return null;
    const row = this.db
      .prepare(
        `SELECT review_id, input_hash, verdict, created_at FROM reviews
         WHERE question_id=? AND question_version=? AND verdict='PASS'
           AND input_hash=?
         ORDER BY created_at DESC, review_id DESC LIMIT 1`,
      )
      .get(questionId, version, cur.contentHash) as
      | { review_id: string; input_hash: string; verdict: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      reviewId: row.review_id,
      inputHash: row.input_hash,
      verdict: row.verdict,
      createdAt: row.created_at,
    };
  }

  /* --------------------------- 映射 --------------------------- */

  private defaultLeaseMs(): number {
    return 30_000;
  }

  private mapTask(r: TaskRow): TaskRecord {
    return {
      taskId: r.task_id,
      batchId: r.batch_id,
      stage: r.stage as TaskStage,
      idempotencyKey: r.idempotency_key,
      inputHash: r.input_hash,
      ruleVersion: r.rule_version,
      promptVersion: r.prompt_version,
      status: r.status as TaskStatus,
      attempt: r.attempt,
      leaseToken: r.lease_token,
      leaseUntil: r.lease_until != null ? toIso(r.lease_until) : null,
      maxAttempts: r.max_attempts,
      backoffMs: r.backoff_ms,
      availableAt: toIso(r.available_at),
      budgetReserved: r.budget_reserved,
      budgetUsed: r.budget_used,
      lastError:
        r.last_error_kind != null
          ? { kind: r.last_error_kind as "TRANSIENT" | "PERMANENT", message: r.last_error_message ?? "" }
          : undefined,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    };
  }
}

interface TaskRow {
  task_id: string;
  batch_id: string;
  stage: string;
  idempotency_key: string;
  input_hash: string;
  rule_version: string;
  prompt_version: string;
  status: string;
  attempt: number;
  lease_token: string | null;
  lease_until: number | null;
  max_attempts: number;
  backoff_ms: number;
  available_at: number;
  budget_reserved: number;
  budget_used: number;
  input_payload: string;
  last_error_kind: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
}

const CANDIDATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  budget_token INTEGER NOT NULL DEFAULT 0,
  budget_spent INTEGER NOT NULL DEFAULT 0,
  budget_reserved INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RUNNING'
);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  uri TEXT NOT NULL,
  license TEXT NOT NULL,
  version_strategy TEXT NOT NULL,
  allowed_use TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  evidence_path TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  converter_version TEXT NOT NULL,
  UNIQUE(source_id, revision, content_hash)
);

CREATE TABLE IF NOT EXISTS works (
  work_id TEXT PRIMARY KEY,
  author_canonical TEXT NOT NULL,
  title_canonical TEXT NOT NULL,
  dynasty TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  author_aliases TEXT NOT NULL DEFAULT '[]',
  title_aliases TEXT NOT NULL DEFAULT '[]',
  current_version_id TEXT
);

CREATE TABLE IF NOT EXISTS work_versions (
  work_version_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  lines TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS question_versions (
  question_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,
  correct_option_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  work_version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  face_fingerprint TEXT NOT NULL,
  revision_round INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(question_id, version)
);
CREATE INDEX IF NOT EXISTS idx_qv_status ON question_versions(status);
CREATE INDEX IF NOT EXISTS idx_qv_face ON question_versions(face_fingerprint);

CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  model_version TEXT NOT NULL,
  independent_answer TEXT NOT NULL,
  issues TEXT NOT NULL DEFAULT '[]',
  verdict TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_qv ON reviews(question_id, question_version, input_hash);
`;

const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  max_attempts INTEGER NOT NULL,
  backoff_ms INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  budget_reserved INTEGER NOT NULL DEFAULT 0,
  budget_used INTEGER NOT NULL DEFAULT 0,
  input_payload TEXT NOT NULL DEFAULT '{}',
  last_error_kind TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, available_at);
CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);

CREATE TABLE IF NOT EXISTS releases (
  release_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  batch_key TEXT NOT NULL UNIQUE,
  rule_version TEXT NOT NULL,
  items TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_audit (
  audit_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS active_release (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  release_id TEXT,
  activated_at TEXT,
  previous_release_id TEXT
);
`;
