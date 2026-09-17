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
}

/** 出题请求参数 */
export interface BuildRoundsOptions {
  stage: PoetryStage;
  /** 轮次数，默认 10 */
  count?: number;
  /** 随机种子（可复现对局，测试用） */
  seed?: number;
  /** 该玩家最近出过的素材 key（跨局防重复，优先出未见过的题） */
  excludeKeys?: string[];
}

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
    /** 下句（仅补下句题型） */
    nextLine?: string;
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
