/**
 * 诗词猜猜 · 纯逻辑层类型定义
 *
 * 约定：lib/games/ 下零框架依赖（不 import next/*、prisma、react），
 * 全部为纯函数，可独立单测、可移植至小程序。
 */

/** 学段分级 */
export enum PoetryStage {
  /** 小学必背（grade 1-6） */
  PRIMARY = "PRIMARY",
  /** 初中（grade 7-9） */
  JUNIOR = "JUNIOR",
  /** 高中（grade 10-12） */
  SENIOR = "SENIOR",
}

/** 诗词题型 */
export enum PoetryQuestionType {
  /** 名句猜诗人 */
  GUESS_POET = "GUESS_POET",
  /** 名句猜诗名 */
  GUESS_TITLE = "GUESS_TITLE",
  /** 上句补下句 */
  COMPLETE_NEXT = "COMPLETE_NEXT",
  /** 选字填空：句中挖一字（□），4 个单字选项（D3 新题型） */
  FILL_CHAR = "FILL_CHAR",
  /** 朝代配对：一句名句，4 个朝代选项（D3 新题型） */
  DYNASTY_PICK = "DYNASTY_PICK",
}

/** 语料条目（对应 Poem 表结构，供引擎消费） */
export interface PoemCorpusItem {
  id: string;
  title: string;
  poet: string;
  dynasty: string;
  grade: number;
  lines: string[];
  famous: boolean;
  /**
   * 冷门度 0-3（3 最冷）。可选：旧种子未标注时按 0 处理，
   * 高阶官阶 `preferCold` 出卷时作为加权因子（不改变低阶行为）。
   */
  cold?: number;
}

/** 出题请求参数（学段模式，旧接口，行为保持不变） */
export interface BuildRoundsOptions {
  stage: PoetryStage;
  /** 轮次数，默认 10 */
  count?: number;
  /** 随机种子（可复现对局，测试用） */
  seed?: number;
  /** 该玩家最近出过的素材 key（跨局防重复，优先出未见过的题） */
  excludeKeys?: string[];
}

/** 对局类型：PRACTICE 研习 / EXAM 科考（晋升大考）/ DAILY 每日题 */
export type RankKind = "PRACTICE" | "EXAM" | "DAILY";

/** 官阶严格出卷参数（诗词升官模式专用） */
export interface RankBuildOptions {
  /** 官阶 id（0..N），对应 rank.ts 的 RANKS */
  rankId: number;
  /** 类型决定取研习窗口还是科考窗口、以及题数（rank.ts countFor） */
  kind: RankKind;
  /** 随机种子（可复现对局，测试用） */
  seed?: number;
  /**
   * 硬排除：这些素材 key（poemId:lineIndex:questionType）一律不得出现。
   * **会试 / 科考 / 每日题一律严格排除**（review 红线：三种模式都不得重复已见题）。
   * 同题面（faceKey）也会被一并排除，防止「换 ID 不改题面」绕过去重。
   */
  excludeKeys?: string[];
  /** 持久化题面身份；原素材被删除或替换 ID 后仍须排除。 */
  excludeFaces?: string[];
}

/**
 * 官阶出卷结果（纯逻辑层专用）。
 * 题量不足时返回 ok:false + 明确原因，由上层识别并「保留进度、等待扩容」，
 * 绝不返回不足题数的正常试卷、不自动晋升、不借更高官阶题。
 */
export type RankedBuildResult =
  | { ok: true; rounds: PoetryRound[] }
  | { ok: false; reason: "EMPTY_CORPUS" | "INSUFFICIENT_CAPACITY"; available: number; required: number };

/** 单轮题目数据（含答案，仅服务端持有） */
export interface PoetryRound {
  roundIndex: number;
  type: PoetryQuestionType;
  /** 题面：名句 / 上句 */
  prompt: string;
  /** 选项（4 选 1） */
  options: string[];
  /** 正确答案索引 */
  answerIndex: number;
  /** 素材稳定 key（跨局去重，仅服务端持有，不下发） */
  sourceKey: string;
  /** 结算回顾用 */
  meta: {
    poemTitle: string;
    poet: string;
    dynasty: string;
    /** 学段分级 1-12（D3：诗词阁落库用，服务端专用不下发） */
    grade: number;
    /** 下句（仅补下句题型） */
    nextLine?: string;
    /** 句位（D3：FILL_CHAR 落库 / faceKey 重构用，服务端专用不下发） */
    lineIndex?: number;
    /** 挖字位置（D3 FILL_CHAR 专用，服务端专用不下发） */
    pos?: number;
  };
}

/** 发给客户端的题目视图（剥离 answerIndex / nextLine） */
export interface PoetryRoundView {
  roundIndex: number;
  type: PoetryQuestionType;
  prompt: string;
  options: string[];
}

/** 学段对应的 grade 区间 */
export const STAGE_GRADE_RANGE: Record<PoetryStage, [number, number]> = {
  [PoetryStage.PRIMARY]: [1, 6],
  [PoetryStage.JUNIOR]: [7, 9],
  [PoetryStage.SENIOR]: [10, 12],
};

/** 将完整轮次转为客户端视图（剥离答案） */
export function toRoundView(round: PoetryRound): PoetryRoundView {
  return {
    roundIndex: round.roundIndex,
    type: round.type,
    prompt: round.prompt,
    options: round.options,
  };
}
