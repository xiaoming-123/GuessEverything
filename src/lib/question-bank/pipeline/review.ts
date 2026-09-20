/**
 * 智能体题库引擎 · 审核/修订闭环（P1）
 *
 * 设计稿第 6/7 节：
 * - 校验（规则校验器，硬门槛，不可被模型投票覆盖）
 * - 独立审核（第一遍不看预设答案，独立作答）
 * - 修订（不改来源事实；创建新版本从 VALIDATING 重跑）
 * - 审核只对「原 inputHash」生效：内容哈希变更 → 旧审核失效，必须重审。
 * - 修订最多 maxRevisionRounds 轮，仍未通过 → QUARANTINED（待人工核验）。
 *
 * 审核版本绑定（核心不变式）：
 *   ReviewRecord.inputHash === 被审核版本的 contentHash
 *   → getLatestPassReview 仅在 inputHash 与「当前」版本 contentHash 一致时生效。
 *     修订/篡改产生新 contentHash → 旧 PASS 记录不再命中 → 发布被阻断。
 */

import { questionContentHash } from "../validators/rules";
import { validateCandidate } from "../validators/rules";
import { correctOptionValue } from "../validators/rules";
import {
  DEFAULT_BUDGET_RULES,
  type BudgetRules,
} from "../contracts/types";
import type {
  CandidateStatus,
  QuestionProvider,
  QuestionVersion,
  SourceEntry,
  SourceSnapshot,
  StructuredIssue,
  Work,
  WorkVersion,
} from "../contracts/types";
import type { QuestionBankDb } from "../infra/question-bank-db";

/** 可被修订器（重取干扰项）自动修复的 issue */
const FIXABLE_CODES = new Set([
  "DUPLICATE_OPTION",
  "DUPLICATE_OPTION_NORM",
  "OPTION_TYPE_MISMATCH",
  "CORRECT_OPTION_AMBIGUOUS",
  "INSUFFICIENT_DISTRACTORS",
]);
/** 硬错误：直接拒绝（内容/证据确定出错） */
const REJECT_CODES = new Set([
  "ANSWER_MISMATCH",
  "SNAPSHOT_HASH_MISMATCH",
  "EVIDENCE_SPAN_INVALID",
  "WORK_VERSION_MISMATCH",
  "CORRECT_OPTION_MISSING",
  "OPTION_COUNT",
  "WORK_TOO_SHORT",
  "PROMPT_NOT_IN_SNAPSHOT",
  "ANSWER_NOT_IN_SNAPSHOT",
]);
/** 待核验：别名/多解/泄漏/注入/来源问题，须人工或补足消歧，不可自动放行 */
const QUARANTINE_CODES = new Set([
  "MULTI_ANSWER",
  "ALIAS_CONFLICT",
  "ANSWER_LEAK",
  "SOURCE_INJECTION",
  "WORK_UNVERIFIED",
  "WORK_NOT_IN_SNAPSHOT",
  "SOURCE_DISABLED",
  "DUPLICATE_FACE",
  "DUPLICATE_QUESTION_ID",
]);

/** 未知 issue 安全兜底 → 待核验 */
type IssueCategory = "FIXABLE" | "REJECT" | "QUARANTINE";
function categorize(issues: StructuredIssue[]): IssueCategory {
  let hasQuarantine = false;
  let hasFixable = false;
  for (const i of issues) {
    if (REJECT_CODES.has(i.code)) return "REJECT";
    if (QUARANTINE_CODES.has(i.code) || !FIXABLE_CODES.has(i.code)) {
      // 不在 fixable 且不在 reject → 待核验（含未知 code 的保守兜底）
      if (!FIXABLE_CODES.has(i.code)) hasQuarantine = true;
    } else {
      hasFixable = true;
    }
  }
  if (hasQuarantine) return "QUARANTINE";
  if (hasFixable) return "FIXABLE";
  return "FIXABLE";
}

export interface ReviewOutcome {
  questionId: string;
  finalVersion: number;
  finalStatus: CandidateStatus;
  approved: boolean;
  /** 实际修订轮数（0 = 初版一次通过） */
  roundsUsed: number;
  versionsCreated: number;
  reviews: Array<{
    reviewId: string;
    version: number;
    inputHash: string;
    verdict: string;
    independentAnswer: string;
    issues: StructuredIssue[];
  }>;
  termination: "APPROVED" | "QUARANTINED" | "REJECTED" | "REVISION_EXHAUSTED";
}

export interface ReviewPipelineDeps {
  db: QuestionBankDb;
  provider: QuestionProvider;
  /** 预算规则覆盖（缺省用 DEFAULT_BUDGET_RULES） */
  rules?: Partial<BudgetRules>;
  /** 注入时钟（ISO），默认 Date.now */
  nowIso?: () => string;
}

export interface ReviewContext {
  source: SourceEntry;
  snapshot: SourceSnapshot;
  work: Work;
  workVersion: WorkVersion;
}

export class ReviewPipeline {
  private readonly db: QuestionBankDb;
  private readonly provider: QuestionProvider;
  private readonly rules: BudgetRules;
  private readonly nowIso: () => string;

  constructor(deps: ReviewPipelineDeps) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.rules = { ...DEFAULT_BUDGET_RULES, ...deps.rules };
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  /**
   * 对一道知识点跑完整审核/修订闭环。
   * initial.version 为命题器产出的 v1（DRAFT）。
   */
  async run(
    initial: { version: QuestionVersion; distractorPool: string[] },
    ctx: ReviewContext,
  ): Promise<ReviewOutcome> {
    const { source, snapshot, work, workVersion } = ctx;
    const questionId = initial.version.questionId;
    const distractorPool = initial.distractorPool;
    const reviews: ReviewOutcome["reviews"] = [];
    let versionsCreated = 0;
    let roundsUsed = 0;

    // 保存初版（幂等：已存在则不覆盖）
    const saved = this.db.saveQuestionVersion(initial.version);
    if (saved.saved) versionsCreated++;

    let versionNo = initial.version.version;
    let status: CandidateStatus = this.db.getQuestionVersion(questionId, versionNo)!.status;

    // 状态推进：确保进入 VALIDATING
    if (status === "DRAFT") {
      this.db.transitionQuestionVersion(
        questionId, versionNo, "VALIDATING",
        this.db.getQuestionVersion(questionId, versionNo)!.contentHash,
      );
      status = "VALIDATING";
    }

    for (;;) {
      const cur = this.db.getQuestionVersion(questionId, versionNo)!;
      const hash = cur.contentHash;

      if (status === "VALIDATING") {
        const res = validateCandidate({
          source, snapshot, work, workVersion,
          version: cur,
          existingFaceFingerprints: this.db.existingFaceFingerprints({ questionId }),
          existingQuestionIds: this.db.existingQuestionIds({ questionId, version: versionNo }),
        });
        if (!res.ok) {
          const cat = categorize(res.issues);
          const roundsLeft = (cur.revisionRound ?? 0) < this.rules.maxRevisionRounds;
          if (cat === "FIXABLE" && roundsLeft) {
            // 标记旧版本被退回，创建修订新版本
            status = await this.applyRevision(
              questionId, versionNo, hash, res.issues, cur, distractorPool,
            );
            versionsCreated++;
            versionNo++;
            roundsUsed++;
            // 新版本从 DRAFT 进入 VALIDATING
            const nv = this.db.getQuestionVersion(questionId, versionNo)!;
            this.db.transitionQuestionVersion(
              questionId, versionNo, "VALIDATING", nv.contentHash,
            );
            status = "VALIDATING";
            continue;
          }
          const target: CandidateStatus =
            cat === "REJECT" ? "REJECTED" : "QUARANTINED";
          if (cat === "FIXABLE") {
            // 修订轮数耗尽
            this.quarantineOrReject(questionId, versionNo, hash, "QUARANTINED");
            return this.buildOutcome(questionId, versionNo, "QUARANTINED", reviews, roundsUsed, versionsCreated, "REVISION_EXHAUSTED");
          }
          this.quarantineOrReject(questionId, versionNo, hash, target);
          return this.buildOutcome(
            questionId, versionNo, target, reviews, roundsUsed, versionsCreated,
            target === "REJECTED" ? "REJECTED" : "QUARANTINED",
          );
        }
        // 校验通过 → REVIEWING
        this.db.transitionQuestionVersion(questionId, versionNo, "REVIEWING", hash);
        status = "REVIEWING";
      }

      if (status === "REVIEWING") {
        const review = await this.doReview(questionId, versionNo, cur, ctx);
        reviews.push(review);
        // 审核记录落库（无论通过与否；inputHash 绑定当前版本内容哈希）
        this.db.saveReview({
          reviewId: review.reviewId, questionId, questionVersion: versionNo,
          inputHash: cur.contentHash, role: "INDEPENDENT_REVIEWER",
          modelVersion: this.provider.name, independentAnswer: review.independentAnswer,
          issues: review.issues, verdict: review.verdict, createdAt: this.nowIso(),
        });
        if (review.verdict === "PASS") {
          this.db.transitionQuestionVersion(questionId, versionNo, "APPROVED", cur.contentHash);
          status = "APPROVED";
          return this.buildOutcome(questionId, versionNo, "APPROVED", reviews, roundsUsed, versionsCreated, "APPROVED");
        }
        // 独立审核不通过 → 待核验（不可自动修复，属内容/歧义问题）
        this.quarantineOrReject(questionId, versionNo, cur.contentHash, "QUARANTINED");
        return this.buildOutcome(questionId, versionNo, "QUARANTINED", reviews, roundsUsed, versionsCreated, "QUARANTINED");
      }

      // 不应到达这里
      break;
    }

    const final = this.db.getQuestionVersion(questionId, versionNo)!;
    return this.buildOutcome(
      questionId, versionNo, final.status, reviews, roundsUsed, versionsCreated,
      final.status === "APPROVED" ? "APPROVED" : "QUARANTINED",
    );
  }

  /** 独立审核：第一遍不看预设答案，独立作答并核对 */
  private async doReview(
    questionId: string,
    versionNo: number,
    cur: QuestionVersion,
    ctx: ReviewContext,
  ): Promise<{
    reviewId: string; version: number; inputHash: string;
    verdict: "PASS" | "REJECT" | "NEEDS_VERIFICATION";
    independentAnswer: string; issues: StructuredIssue[];
  }> {
    const reviewId = `${questionId}:v${versionNo}:review`;
    const correct = correctOptionValue(cur) ?? "";
    const out = await this.provider.invoke({
      stage: "REVIEW",
      promptVersion: { stage: "REVIEW", version: this.provider.name },
      // 第一遍不看预设答案与命题解释（设计稿第 3 节）：
      // facts 不含 correct，仅凭已核验原文证据独立作答。
      facts: {
        questionType: cur.type,
        prompt: cur.prompt,
        workVersion: ctx.workVersion,
        options: cur.options,
      },
      seed: versionNo,
    });

    const issues: StructuredIssue[] = [];
    if (!out.ok) {
      issues.push({
        code: out.error?.kind === "PERMANENT" ? "REVIEW_PROVIDER_ERROR" : "REVIEW_TRANSIENT",
        message: out.error?.message ?? "审核 provider 错误",
      });
    } else {
      const independent = (out.payload.independentAnswer as string) ?? "";
      const injection = Boolean(out.payload.injectionDetected);
      if (injection) {
        issues.push({
          code: "SOURCE_INJECTION",
          message: "审核阶段检测到外部原文含指令性措辞（提示注入特征）",
        });
      }
      if (independent !== correct) {
        issues.push({
          code: "REVIEW_ANSWER_MISMATCH",
          message: `独立作答「${independent || "(空)"}」与正确答案「${correct}」不一致`,
        });
      }
    }

    const verdict = issues.length === 0 ? "PASS" : "REJECT";
    return {
      reviewId, version: versionNo, inputHash: cur.contentHash,
      verdict, independentAnswer: (out.payload.independentAnswer as string) ?? "", issues,
    };
  }

  /**
   * 应用修订：标记旧版本 NEEDS_REVISION，用 provider 重取选项，
   * 创建新版本（version+1，DRAFT，revisionRound+1）。返回新版本状态（DRAFT）。
   */
  private async applyRevision(
    questionId: string,
    versionNo: number,
    hash: string,
    issues: StructuredIssue[],
    cur: QuestionVersion,
    distractorPool: string[],
  ): Promise<CandidateStatus> {
    // 标记旧版本被退回（记录修订原因）
    this.db.transitionQuestionVersion(questionId, versionNo, "NEEDS_REVISION", hash);

    const correct = correctOptionValue(cur) ?? "";
    const out = await this.provider.invoke({
      stage: "REVISE",
      promptVersion: { stage: "REVISE", version: this.provider.name },
      facts: {
        questionType: cur.type,
        prompt: cur.prompt,
        correct,
        options: cur.options,
        issues,
        distractorPool,
      },
      seed: versionNo + 1,
    });

    let newOptions: string[];
    if (out.ok && Array.isArray(out.payload.options) && (out.payload.options as string[]).length === 4) {
      newOptions = out.payload.options as string[];
    } else {
      // provider 无法确定性修复（如非选项类 issue）→ 直接视为不可修复
      // 这里回退到原选项（由上层 categorize 已保证进入此处的是 FIXABLE，正常应成功）
      newOptions = [...cur.options] as string[];
    }

    const nextVersion: QuestionVersion = {
      ...cur,
      version: versionNo + 1,
      options: newOptions as [string, string, string, string],
      // 正确项位置可能变化：保持 correctOptionId 指向正确值
      correctOptionId: newOptions[0],
      status: "DRAFT",
      revisionRound: (cur.revisionRound ?? 0) + 1,
    };
    // correctOptionId 必须指向正确答案值（修订器约定 options[0] 为正确项）
    const correctIdx = newOptions.indexOf(correct);
    nextVersion.correctOptionId = correctIdx >= 0 ? newOptions[correctIdx] : newOptions[0];
    nextVersion.contentHash = questionContentHash(nextVersion);

    this.db.saveQuestionVersion(nextVersion);
    return "DRAFT";
  }

  private quarantineOrReject(
    questionId: string,
    versionNo: number,
    hash: string,
    to: "QUARANTINED" | "REJECTED",
  ): void {
    // 状态机守卫：VALIDATING/REVIEWING 均可进入这两个状态
    this.db.transitionQuestionVersion(questionId, versionNo, to, hash);
  }

  private buildOutcome(
    questionId: string,
    versionNo: number,
    status: CandidateStatus,
    reviews: ReviewOutcome["reviews"],
    roundsUsed: number,
    versionsCreated: number,
    termination: ReviewOutcome["termination"],
  ): ReviewOutcome {
    return {
      questionId, finalVersion: versionNo, finalStatus: status,
      approved: status === "APPROVED", roundsUsed, versionsCreated, reviews, termination,
    };
  }
}
