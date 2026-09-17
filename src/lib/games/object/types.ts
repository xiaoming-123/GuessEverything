/**
 * 物品猜猜 · 纯逻辑层类型定义
 *
 * 约定：lib/games/ 下零框架依赖（不 import next/*、prisma、react），
 * 全部为纯函数，可独立单测、可移植至小程序。
 *
 * 题型：线索描述猜物品 / 公版民间谜语猜物品 / 猜分类。
 */

/** 物品分类 */
export enum ObjectCategory {
  /** 动物 */
  ANIMAL = "ANIMAL",
  /** 植物 */
  PLANT = "PLANT",
  /** 食物饮品 */
  FOOD = "FOOD",
  /** 生活用品 */
  DAILY = "DAILY",
  /** 文具 */
  STATIONERY = "STATIONERY",
  /** 自然天象 */
  NATURE = "NATURE",
}

/** 物品题型 */
export enum ObjectQuestionType {
  /** 根据多条线索猜物品 */
  GUESS_FROM_CLUES = "GUESS_FROM_CLUES",
  /** 根据民间谜语谜面猜物品 */
  GUESS_FROM_RIDDLE = "GUESS_FROM_RIDDLE",
  /** 给出物品名猜分类 */
  GUESS_CATEGORY = "GUESS_CATEGORY",
}

/** 难度档位 */
export enum ObjectDifficulty {
  EASY = "EASY",
  NORMAL = "NORMAL",
  HARD = "HARD",
}

/** 物品语料条目（对应 ObjectItem 表结构，供引擎消费） */
export interface ObjectCorpusItem {
  id: string;
  name: string;
  category: ObjectCategory;
  /** 难度 1-3：1 入门 / 2 进阶 / 3 骨灰 */
  difficulty: number;
  /** 特征线索（由笼统到具体，3 条） */
  clues: string[];
  /** 公版民间谜语谜面（可空） */
  riddle?: string;
}

/** 出题请求参数 */
export interface BuildRoundsOptions {
  difficulty: ObjectDifficulty;
  /** 轮次数，默认 10 */
  count?: number;
  /** 随机种子（可复现对局，测试用） */
  seed?: number;
  /** 该玩家最近出过的素材 key（跨局防重复） */
  excludeKeys?: string[];
}

/** 单轮题目数据（含答案，仅服务端持有） */
export interface ObjectRound {
  roundIndex: number;
  type: ObjectQuestionType;
  /** 题面（线索题取首条线索，谜语题为谜面，分类题为物品名引导句） */
  prompt: string;
  /** 展示用线索（线索题多条、谜语题为谜面单条） */
  clues: string[];
  /** 选项（4 选 1）：物品名或分类名 */
  options: string[];
  /** 正确答案索引 */
  answerIndex: number;
  /** 素材稳定 key（跨局去重，仅服务端持有，不下发） */
  sourceKey: string;
  /** 结算回顾用 */
  meta: {
    name: string;
    category: ObjectCategory;
    /** 全部线索（解析展示） */
    clues: string[];
    /** 民间谜语谜面（解析展示） */
    riddle?: string;
  };
}

/** 发给客户端的题目视图（剥离 answerIndex / meta） */
export interface ObjectRoundView {
  roundIndex: number;
  type: ObjectQuestionType;
  prompt: string;
  clues: string[];
  options: string[];
}

/** 难度档位对应的难度值区间（高档位包含低档位语料） */
export const DIFFICULTY_RANGE: Record<ObjectDifficulty, [number, number]> = {
  [ObjectDifficulty.EASY]: [1, 1],
  [ObjectDifficulty.NORMAL]: [1, 2],
  [ObjectDifficulty.HARD]: [1, 3],
};

/**
 * 各档位对语料难度 1/2/3 的抽题权重（高档位高难素材占多数）
 */
export const DIFFICULTY_WEIGHTS: Record<ObjectDifficulty, [number, number, number]> = {
  [ObjectDifficulty.EASY]: [1, 0.15, 0.03],
  [ObjectDifficulty.NORMAL]: [0.3, 1, 0.4],
  [ObjectDifficulty.HARD]: [0.08, 0.45, 1],
};

/** 分类中文标签 */
export const CATEGORY_LABEL: Record<ObjectCategory, string> = {
  [ObjectCategory.ANIMAL]: "动物",
  [ObjectCategory.PLANT]: "植物",
  [ObjectCategory.FOOD]: "食物饮品",
  [ObjectCategory.DAILY]: "生活用品",
  [ObjectCategory.STATIONERY]: "文具",
  [ObjectCategory.NATURE]: "自然天象",
};

/** 将完整轮次转为客户端视图（剥离答案） */
export function toRoundView(round: ObjectRound): ObjectRoundView {
  return {
    roundIndex: round.roundIndex,
    type: round.type,
    prompt: round.prompt,
    clues: round.clues,
    options: round.options,
  };
}
