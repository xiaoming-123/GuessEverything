/**
 * 飞花令 · 纯逻辑层类型定义
 *
 * 约定：lib/games/ 下零框架依赖（不 import next/*、prisma、react），
 * 全部为纯函数，可独立单测、可移植至小程序。
 *
 * 玩法：令字飞花。给定令字辨诗句是否含字，或据诗句反猜令字。
 * 语料复用诗词猜猜（PoemCorpusItem），由 corpus.ts 拆句建索引，无需独立词表。
 */

/** 难度档位（与演员/物品一致：入门 / 进阶 / 骨灰） */
export enum FeihuaDifficulty {
  EASY = "EASY",
  NORMAL = "NORMAL",
  HARD = "HARD",
}

/** 飞花令题型 */
export enum FeihuaQuestionType {
  /** 寻句：下列哪句诗含有令字（1 含 3 不含） */
  FIND_CONTAINS = "FIND_CONTAINS",
  /** 挑白：下列哪句诗不含令字（3 含 1 不含） */
  FIND_MISSING = "FIND_MISSING",
  /** 猜令：这句诗可以飞哪个令字（1 中 3 不中） */
  GUESS_CHAR = "GUESS_CHAR",
}

/** 诗句素材（由诗词语料按行拆分而来） */
export interface FeihuaSentence {
  /** 稳定 ID：`${诗 ID}#${句索引}` */
  id: string;
  /** 诗句原文 */
  text: string;
  poemId: string;
  poemTitle: string;
  poet: string;
  dynasty: string;
  /** 1 入门 / 2 进阶 / 3 骨灰（按原诗 grade 推导） */
  difficulty: 1 | 2 | 3;
  famous: boolean;
}

/** 出题请求参数 */
export interface BuildRoundsOptions {
  difficulty: FeihuaDifficulty;
  /** 轮次数，默认 10 */
  count?: number;
  /** 随机种子（可复现对局，测试用） */
  seed?: number;
  /** 该玩家最近出过的素材 key（跨局防重复） */
  excludeKeys?: string[];
}

/** 单轮题目数据（含答案，仅服务端持有） */
export interface FeihuaRound {
  roundIndex: number;
  type: FeihuaQuestionType;
  /** 题面：猜令题为诗句原文；寻句/挑白题为空（令字走 lingChar 卡片） */
  prompt: string;
  /** 选项（4 选 1；猜令题为单字） */
  options: string[];
  /** 正确答案索引 */
  answerIndex: number;
  /** 素材稳定 key（跨局去重，仅服务端持有，不下发） */
  sourceKey: string;
  /** 结算回顾用 */
  meta: {
    /** 令字（猜令题为正确字） */
    lingChar: string;
    /** 判定诗句（寻句/挑白为正确选项；猜令为题干诗句） */
    sentence: string;
    poemTitle: string;
    poet: string;
    dynasty: string;
  };
}

/** 发给客户端的题目视图（剥离 answerIndex / sourceKey / meta） */
export interface FeihuaRoundView {
  roundIndex: number;
  type: FeihuaQuestionType;
  prompt: string;
  options: string[];
  /** 令字（寻句/挑白大卡展示；猜令题为空串） */
  lingChar: string;
}

/** 难度档位对应的句子难度值区间（高档位包含低档位语料） */
export const DIFFICULTY_RANGE: Record<FeihuaDifficulty, [number, number]> = {
  [FeihuaDifficulty.EASY]: [1, 1],
  [FeihuaDifficulty.NORMAL]: [1, 2],
  [FeihuaDifficulty.HARD]: [1, 3],
};

/**
 * 各档位对句子难度 1/2/3 的抽题权重（与演员/物品同款加权抽样）
 */
export const DIFFICULTY_WEIGHTS: Record<FeihuaDifficulty, [number, number, number]> = {
  [FeihuaDifficulty.EASY]: [1, 0.15, 0.03],
  [FeihuaDifficulty.NORMAL]: [0.3, 1, 0.4],
  [FeihuaDifficulty.HARD]: [0.08, 0.45, 1],
};

/**
 * 各档位的题型配方（循环取用）
 * 入门只寻句；进阶加猜令；骨灰再加最考验眼力的挑白
 */
export const TYPE_MIX: Record<FeihuaDifficulty, FeihuaQuestionType[]> = {
  [FeihuaDifficulty.EASY]: [FeihuaQuestionType.FIND_CONTAINS],
  [FeihuaDifficulty.NORMAL]: [
    FeihuaQuestionType.FIND_CONTAINS,
    FeihuaQuestionType.FIND_CONTAINS,
    FeihuaQuestionType.GUESS_CHAR,
  ],
  [FeihuaDifficulty.HARD]: [
    FeihuaQuestionType.FIND_CONTAINS,
    FeihuaQuestionType.FIND_MISSING,
    FeihuaQuestionType.GUESS_CHAR,
  ],
};

/** 将完整轮次转为客户端视图（剥离答案） */
export function toRoundView(round: FeihuaRound): FeihuaRoundView {
  return {
    roundIndex: round.roundIndex,
    type: round.type,
    prompt: round.prompt,
    options: round.options,
    lingChar: round.meta.lingChar,
  };
}
