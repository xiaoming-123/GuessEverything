/**
 * 智能体题库引擎 · 确定性发布器（P1，程序，非模型）
 *
 * 设计稿第 7 节：
 * - 自动发布只接受通过硬规则、审核、重复检查的固定版本；
 * - 审核哈希与发布哈希必须一致（条目 contentHash === 审核 inputHash）；
 * - 发布器在事务中写清单并切换指针；相同批次重试不产生第二份发布；
 * - 回滚只切回先前清单，不删除玩家记录。
 *
 * 本模块只做「候选区 → 不可变清单 → 激活指针」的确定性流转；
 * 不含网络、不含模型。
 */

import { sha256Hex } from "../sources/evidence";
import type {
  ReleaseItem,
  ReleaseManifest,
  StructuredIssue,
} from "../contracts/types";
import type { QuestionBankDb } from "../infra/question-bank-db";

export const PUBLISHER_RULE_VERSION = "publish-v1";

/**
 * 构建发布清单（不写库，先做验收）：
 * 收集所有 APPROVED 候选题版本，逐条核对审核哈希，产出不可变清单。
 *
 * 验收失败项：
 * - REVIEW_INPUT_HASH_MISMATCH：条目 contentHash 与通过审核 inputHash 不一致
 *   （审核后版本被修改 → 旧审核失效，禁止发布）
 * - NO_PASS_REVIEW：无与当前版本哈希一致的通过审核
 */
export function buildManifest(
  db: QuestionBankDb,
  batchKey: string,
  releaseId: string,
  batchId: string,
  createdAt: string,
): ReleaseManifest {
  const issues: StructuredIssue[] = [];
  const approved = db.listQuestionVersions("APPROVED");
  const items: ReleaseItem[] = [];

  for (const v of approved) {
    const review = db.getLatestPassReview(v.questionId, v.version);
    if (!review) {
      issues.push({
        code: "NO_PASS_REVIEW",
        message: `知识点 ${v.questionId} v${v.version} 无与当前内容哈希一致的通过审核`,
        location: `${v.questionId}#v${v.version}`,
      });
      continue;
    }
    if (review.inputHash !== v.contentHash) {
      issues.push({
        code: "REVIEW_INPUT_HASH_MISMATCH",
        message: `知识点 ${v.questionId} v${v.version} 审核哈希 ${review.inputHash} 与发布哈希 ${v.contentHash} 不一致（版本被修改，旧审核失效）`,
        location: `${v.questionId}#v${v.version}`,
      });
      continue;
    }
    const correct = v.options[v.options.indexOf(v.correctOptionId)] ?? "";
    items.push({
      questionId: v.questionId,
      questionVersion: v.version,
      contentHash: v.contentHash,
      reviewInputHash: review.inputHash,
      reviewId: review.reviewId,
      type: v.type,
      difficultyHint: v.difficultyHint,
    });
    void correct;
  }

  // 确定性清单哈希：批次键 + 规则版本 + 有序条目
  const canon = [
    batchKey,
    PUBLISHER_RULE_VERSION,
    ...items.map((i) =>
      [i.questionId, String(i.questionVersion), i.contentHash, i.reviewInputHash, i.type].join("="),
    ),
  ].join("\n");
  const manifestHash = sha256Hex(canon);

  const acceptance: ReleaseManifest["acceptance"] =
    issues.length === 0
      ? { ok: true, issues: [] }
      : { ok: false, issues };

  return {
    releaseId,
    batchId,
    batchKey,
    ruleVersion: PUBLISHER_RULE_VERSION,
    items,
    manifestHash,
    acceptance,
    createdAt,
  };
}

export interface PublishResult {
  ok: boolean;
  reason?: string;
  releaseId?: string;
  manifestHash?: string;
  itemCount?: number;
  activated?: boolean;
  /** 清单幂等：重复发布返回既有清单（created=false 语义由 releaseId 相同体现） */
  idempotent?: boolean;
}

/**
 * 发布：验收 → 事务写清单 → （可选）原子激活。
 * 验收失败 → 不写清单（记 REJECTED 审计），不激活。
 */
export function publishBatch(
  db: QuestionBankDb,
  input: {
    batchId: string;
    batchKey: string;
    releaseId: string;
    createdAt: string;
    /** 是否同时激活（activate=false 时仅写清单，不切指针） */
    activate?: boolean;
    /** 激活时比较的旧指针（compare-and-swap） */
    expectedPrevious?: string | null;
  },
): PublishResult {
  const manifest = buildManifest(
    db,
    input.batchKey,
    input.releaseId,
    input.batchId,
    input.createdAt,
  );

  const stored = db.upsertRelease({
    releaseId: manifest.releaseId,
    batchId: manifest.batchId,
    batchKey: manifest.batchKey,
    ruleVersion: manifest.ruleVersion,
    items: manifest.items,
    manifestHash: manifest.manifestHash,
    acceptance: { ok: manifest.acceptance.ok, issues: manifest.acceptance.issues.map((i) => i.code) },
    createdAt: manifest.createdAt,
  });
  if (!("releaseId" in stored)) {
    return { ok: false, reason: stored.reason, itemCount: 0 };
  }
  const createdNew = stored.created;
  const releaseId = stored.releaseId;
  const storedRel = db.getRelease(releaseId);

  let activated = false;
  if (input.activate && storedRel) {
    const expectedPrevious =
      input.expectedPrevious !== undefined
        ? input.expectedPrevious
        : (db.getActiveRelease()?.releaseId ?? null);
    const act = db.activateRelease(releaseId, expectedPrevious, input.createdAt);
    if (!act.ok) {
      return {
        ok: false,
        reason: `清单已写入但激活失败：${act.reason}`,
        releaseId,
        manifestHash: storedRel.manifestHash,
        itemCount: storedRel.items.length,
        idempotent: !createdNew,
      };
    }
    activated = true;
  }

  return {
    ok: true,
    releaseId,
    manifestHash: storedRel?.manifestHash ?? manifest.manifestHash,
    itemCount: storedRel?.items.length ?? manifest.items.length,
    activated,
    idempotent: !createdNew,
  };
}

/** 回滚到指定清单（或清空激活指针） */
export function rollbackTo(
  db: QuestionBankDb,
  target: string | null,
  nowIso: string,
): { ok: boolean; reason?: string } {
  const current = db.getActiveRelease()?.releaseId ?? null;
  const res = db.rollbackRelease(current, target, nowIso);
  return res.ok ? { ok: true } : { ok: false, reason: res.reason };
}
