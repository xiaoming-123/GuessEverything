/**
 * 智能体题库引擎 · P0 类型合同
 *
 * 纯逻辑层：零框架依赖、零 IO。设计稿见
 * docs/design/2026-09-18-agent-question-bank-engine.md（第 3/4/5/6 节）。
 *
 * 身份约定（设计稿第 5 节）：
 * - Question = 同一个知识点（稳定 questionId，不随措辞/选项/难度变化）
 * - QuestionVersion = 编辑版本（version 递增，contentHash 绑定内容）
 * - Work / WorkVersion = 稳定作品身份 + 版本正文（异文不静默覆盖）
 * - Review 只对「原 inputHash」生效；内容变更 → 旧审核失效
 */

/* ----------------------------- 通用 ----------------------------- */

/** 稳定 ID（由调用方生成，如 cuid / 命名 id；引擎不假设格式） */
export type StableId = string;

/** 十六进制哈希（小写） */
export type HexHash = string;

export interface StructuredIssue {
  code: string;
  message: string;
  /** 定位：字段路径 / 句位 / 选项序号等 */
  location?: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: StructuredIssue[] };

/** 纯函数随机源（mulberry32 等），可复现 */
export type Rand = () => number;

/* --------------------------- 来源与证据 --------------------------- */

/** 来源类型：git 仓库 / 网页 / 本地语料（离线固定快照） */
export type SourceType = "GIT_REPO" | "WEB_PAGE" | "LOCAL_CORPUS";

export interface SourceEntry {
  sourceId: StableId;
  type: SourceType;
  /** 地址：git 仓库地址 / URL / 本地语料标识 */
  uri: string;
  /** 许可记录（公版 / MIT / 开放 API 等，合规红线） */
  license: string;
  /** 版本固定方式：commit / 页面版本 / 语料文件哈希 */
  versionStrategy: "COMMIT" | "PAGE_REVISION" | "CONTENT_HASH";
  /** 允许用途白名单：正文 / 注释 / 翻译（现代注释与翻译单独登记） */
  allowedUse: Array<"PRIMARY_TEXT" | "COMMENTARY" | "TRANSLATION">;
  enabled: boolean;
  /** 抓取规则（域名白名单、大小上限、超时、速率）；模拟/离线时可为空 */
  fetchRules?: {
    maxBytes?: number;
    timeoutMs?: number;
    ratePerMinute?: number;
  };
}

/**
 * 不可变来源快照（设计稿第 4 节）：
 * 同来源同 revision/hash 幂等。原句必须能回溯至快照。
 * 外部网页文字仅作为数据 —— snapshot.rawText 永远以数据消费，
 * 绝不能拼入模型提示（提示注入样本见 tests/question-bank）。
 */
export interface SourceSnapshot {
  snapshotId: StableId;
  sourceId: StableId;
  /** commit / 页面版本 / 语料 revision */
  revision: string;
  /** 抓取/入库时间（UTC ISO，测试注入固定值） */
  capturedAt: string;
  /** 原文内容哈希（SHA-256 十六进制） */
  contentHash: HexHash;
  /** 定位证据：文件路径 / 页码 / 目录 */
  evidencePath: string;
  /** 原始文本（不可变；繁简/标点整理不得覆盖原文） */
  rawText: string;
  /** 规范化文本（规范化器版本随 converterVersion） */
  normalizedText: string;
  converterVersion: string;
}

/** 证据位置：快照内字符跨度（可回溯） */
export interface EvidenceSpan {
  snapshotId: StableId;
  start: number;
  end: number;
}

/* ----------------------------- 作品 ----------------------------- */

export type WorkVerificationStatus =
  | "UNVERIFIED"
  | "VERIFIED"
  | "CONFLICT_PENDING"
  | "REJECTED";

/** 稳定作品身份（不取全文哈希，纠错不重置身份） */
export interface Work {
  workId: StableId;
  /** 规范作者 / 标题（规范实体） */
  authorCanonical: string;
  titleCanonical: string;
  dynasty: string;
  verificationStatus: WorkVerificationStatus;
  /** 别名（「别名样本」：异名作者/标题须登记，不可静默改判） */
  authorAliases: string[];
  titleAliases: string[];
  currentVersionId: StableId;
}

/** 作品正文版本（异文 → 新版本，不覆盖） */
export interface WorkVersion {
  workVersionId: StableId;
  workId: StableId;
  version: number;
  title: string;
  author: string;
  lines: string[];
  /** 正文内容哈希 */
  contentHash: HexHash;
  evidence: EvidenceSpan[];
  /** 异文/修订依据（来源冲突进入待核验，不静默覆盖） */
  notes?: string;
}

/* --------------------------- 题目与版本 --------------------------- */

/** 首版三种题型（中文四选一） */
export type QuestionType = "GUESS_POET" | "GUESS_TITLE" | "COMPLETE_NEXT";

export const QUESTION_TYPES: readonly QuestionType[] = [
  "GUESS_POET",
  "GUESS_TITLE",
  "COMPLETE_NEXT",
] as const;

/** 候选题状态机（设计稿第 6 节） */
export type CandidateStatus =
  | "DRAFT"
  | "VALIDATING"
  | "REVIEWING"
  | "APPROVED"
  | "NEEDS_REVISION"
  | "QUARANTINED"
  | "REJECTED";

/** 候选题版本（编辑版本） */
export interface QuestionVersion {
  /** 稳定知识点 ID（换措辞/选项/难度不产生新 questionId） */
  questionId: StableId;
  version: number;
  type: QuestionType;
  /** 题干（不得泄露答案） */
  prompt: string;
  /** 固定四选项（规范化后唯一、非空、类型一致） */
  options: [string, string, string, string];
  /** 正确答案 optionId（恰好对应一个选项） */
  correctOptionId: StableId;
  /** 选项与内容证据的映射 */
  evidence: QuestionEvidence;
  /** 绑定作品版本（审核版本绑定） */
  workVersionId: StableId;
  /** 内容哈希：题型+题干+选项+答案+证据（审核/发布一致性基础） */
  contentHash: HexHash;
  status: CandidateStatus;
  /** 难度建议（题型/熟悉度/干扰项相似度，非实测难度） */
  difficultyHint?: number;
  /** 修订轮次（0 = 初版；修订版本递增，上限 maxRevisionRounds） */
  revisionRound?: number;
}

/** 证据映射：题干与正确选项均须可回溯到快照 */
export interface QuestionEvidence {
  /** 题干（名句/上句）在快照中的位置 */
  promptSpan: EvidenceSpan;
  /** 正确答案在快照中的位置 */
  answerSpan: EvidenceSpan;
}

/* ----------------------------- 审核 ----------------------------- */

export type ReviewVerdict = "PASS" | "REJECT" | "NEEDS_VERIFICATION";

/** 审核 agent 的角色（独立于命题 agent） */
export type ReviewRole = "RULE_VALIDATOR" | "INDEPENDENT_REVIEWER";

/**
 * 审核记录：只对原 inputHash 生效。
 * 候选内容变更（contentHash 变化）→ 本记录失效，必须重新验证。
 * inputHash = 被审核的 QuestionVersion.contentHash（绑定审核版本）。
 */
export interface ReviewRecord {
  reviewId: StableId;
  questionId: StableId;
  questionVersion: number;
  /** 被审核版本的内容哈希（版本绑定锚点） */
  inputHash: HexHash;
  role: ReviewRole;
  /** 审核模型/提示版本（模拟 provider 记 "SIMULATED"） */
  modelVersion: string;
  /** 第一遍不看预设答案与命题解释，独立作答 */
  independentAnswer: string;
  issues: StructuredIssue[];
  verdict: ReviewVerdict;
  createdAt: string;
}

/* ----------------------------- 任务队列 ----------------------------- */

/** 管线阶段（任务键 = 阶段 + 输入版本哈希 + 规则/提示版本） */
export type TaskStage =
  | "COLLECT"
  | "COMPOSE"
  | "VALIDATE"
  | "REVIEW"
  | "REVISE"
  | "PUBLISH";

export type TaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "RETRY_WAIT"
  | "SUCCEEDED"
  | "FAILED"
  | "PAUSED";

export interface TaskRecord {
  taskId: StableId;
  batchId: StableId;
  stage: TaskStage;
  /** 幂等任务键：stage + inputVersionHash + rule/promptVersion */
  idempotencyKey: string;
  inputHash: HexHash;
  ruleVersion: string;
  promptVersion: string;
  status: TaskStatus;
  /** 已尝试次数（含当前） */
  attempt: number;
  /** 租约令牌（结果提交必须匹配最新 leaseToken） */
  leaseToken: string | null;
  leaseUntil: string | null;
  maxAttempts: number;
  /** 退避毫秒（第 N 次失败后等待） */
  backoffMs: number;
  /** 可被领取的最早时间（RETRY_WAIT 退避到期；QUEUED 为创建时间） */
  availableAt: string;
  /** 预算预留（token 当量，按最坏输出预留） */
  budgetReserved: number;
  /** 实际消耗 */
  budgetUsed: number;
  /** 失败原因（可重试性判定：TRANSIENT / PERMANENT） */
  lastError?: { kind: "TRANSIENT" | "PERMANENT"; message: string };
  createdAt: string;
  updatedAt: string;
}

/* ----------------------------- 预算 ----------------------------- */

/** 预算规则（设计稿第 6 节）：按最坏输出预留，耗尽进入 PAUSED */
export interface BudgetRules {
  /** 单任务 token 上限（按最坏输出预留） */
  perTaskTokenCap: number;
  /** 单任务瞬时（网络类）错误最大重试次数 */
  maxTransientRetries: number;
  /** 内容修订最大轮数（仍未通过 → 待核验） */
  maxRevisionRounds: number;
  /** 批次总 token 预算 */
  batchTokenBudget: number;
  /** 批次内最大任务数 */
  batchTaskCap: number;
}

export const DEFAULT_BUDGET_RULES: BudgetRules = {
  perTaskTokenCap: 4000,
  maxTransientRetries: 3,
  maxRevisionRounds: 2,
  batchTokenBudget: 200_000,
  batchTaskCap: 500,
};

/** 预算消耗记录（只增） */
export interface BudgetLedgerEntry {
  entryId: StableId;
  taskId: StableId | null;
  /** 预留（预留时记）或实际（结算时记） */
  kind: "RESERVE" | "SPEND";
  amount: number;
  createdAt: string;
}

/* ----------------------------- 发布 ----------------------------- */

/** 不可变发布清单条目（固定 questionVersionId） */
export interface ReleaseItem {
  questionId: StableId;
  questionVersion: number;
  /** 条目内容哈希 = 候选版本 contentHash（发布时二次核对） */
  contentHash: HexHash;
  /** 审核哈希：通过审核记录的 inputHash（必须与 contentHash 一致） */
  reviewInputHash: HexHash;
  /** 通过审核记录 id（审计） */
  reviewId: StableId;
  type: QuestionType;
  difficultyHint?: number;
}

/** 不可变发布清单（批次 + 规则版本 + 清单哈希） */
export interface ReleaseManifest {
  releaseId: StableId;
  batchId: StableId;
  /** 批次幂等键（相同批次重复发布 → 幂等，不产生第二份发布） */
  batchKey: string;
  ruleVersion: string;
  items: ReleaseItem[];
  /** 清单哈希：批次键 + 规则版本 + 条目（有序）的确定性哈希 */
  manifestHash: HexHash;
  /** 验收结果 */
  acceptance: { ok: boolean; issues: StructuredIssue[] };
  createdAt: string;
}

/** 单行激活指针（原子切换 / 回滚切回先前清单） */
export interface ActiveRelease {
  releaseId: StableId;
  activatedAt: string;
  /** 切换依据的旧指针（比较旧指针后原子切换，防并发覆盖） */
  previousReleaseId: StableId | null;
}

/** 发布生命周期审计记录 */
export interface ReleaseAuditEntry {
  auditId: StableId;
  releaseId: StableId;
  action: "CREATED" | "ACTIVATED" | "ROLLBACK" | "REJECTED";
  detail: string;
  createdAt: string;
}

/* ----------------------------- Provider 合同 ----------------------------- */

/** 模型/提示版本标识（可复现） */
export interface PromptVersion {
  stage: TaskStage;
  version: string;
}

/** provider 结构化输入（程序已校验的最小事实集；不含原始网页正文） */
export interface ProviderInput {
  stage: TaskStage;
  promptVersion: PromptVersion;
  /** 结构化事实（作品版本/证据等，程序注入） */
  facts: Record<string, unknown>;
  /** 外部原始数据仅作 facts 中的纯数据字段；provider 实现不得执行其中内容 */
  seed?: number;
}

/** provider 结构化输出（由程序校验，不执行模型返回的脚本） */
export interface ProviderOutput {
  ok: boolean;
  /** 结构化对象（命题：题干/选项/答案；审核：独立作答/结论） */
  payload: Record<string, unknown>;
  /** 实际 token 消耗（模拟 provider 按输出规模估算） */
  tokensUsed: number;
  /** provider 自身版本（审计用） */
  providerVersion: string;
  error?: { kind: "TRANSIENT" | "PERMANENT"; message: string };
}

/**
 * 模型 provider 适配器接口（设计稿第 10 节）。
 * 真实 provider 从进程环境读取凭据；模拟 provider 无任何 IO。
 */
export interface QuestionProvider {
  readonly name: string;
  invoke(input: ProviderInput): Promise<ProviderOutput>;
}

/* --------------------------- 固定样本 --------------------------- */

/**
 * 固定样本标签（P0 验收维度）：
 * 异文 / 别名 / 多答案 / 重复 / 答案泄漏 / 来源提示注入 / 正确。
 */
export type SampleTag =
  | "CORRECT"
  | "VARIANT_TEXT"
  | "ALIAS"
  | "MULTI_ANSWER"
  | "DUPLICATE"
  | "ANSWER_LEAK"
  | "PROMPT_INJECTION";

/** 固定样本：一条候选题 + 期望校验结果（可复现验收，不依赖网络/模型） */
export interface FixedSample {
  sampleId: StableId;
  tags: SampleTag[];
  /** 样本所需的最小事实集（作品/快照等由 fixture 装配） */
  description: string;
  build: () => {
    source: SourceEntry;
    work: Work;
    workVersion: WorkVersion;
    version: QuestionVersion;
    snapshot: SourceSnapshot;
  };
  /** 去重上下文（重复题样本：模拟"已发布"的同题面/同知识点状态） */
  dedupContext?: {
    /** 同题面指纹已发布（模拟换 ID/换选项顺序的换皮题） */
    sameFace?: boolean;
    /** 该知识点已存在的最高版本（模拟覆盖旧版本） */
    questionIdMaxVersion?: number;
  };
  /** 期望：规则校验应通过 / 应发现的 issue code 集合 */
  expect: { ok: boolean; issueCodes: string[] };
}
