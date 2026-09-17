/**
 * 演员猜猜 · 纯逻辑层类型定义
 *
 * 约定：lib/games/ 下零框架依赖（不 import next/*、prisma、react），
 * 全部为纯函数，可独立单测、可移植至小程序。
 *
 * 合规红线：只允许纯文字信息（姓名 / 作品名 / 角色名），
 * 禁止任何肖像、剧照与长篇台词。
 */

/** 演员地区（干扰项优先同地区） */
export enum ActorRegion {
  /** 中国内地 */
  MAINLAND = "MAINLAND",
  /** 中国港台 */
  HK_TW = "HK_TW",
  /** 海外（好莱坞等） */
  OVERSEAS = "OVERSEAS",
}

/** 演员题型 */
export enum ActorQuestionType {
  /** 据代表作猜演员 */
  GUESS_FROM_WORKS = "GUESS_FROM_WORKS",
  /** 据经典角色猜演员 */
  GUESS_FROM_ROLES = "GUESS_FROM_ROLES",
  /** 据演员与角色猜作品 */
  GUESS_WORK = "GUESS_WORK",
}

/** 经典角色条目（角色名必须归属该演员的某部作品） */
export interface ActorRole {
  role: string;
  work: string;
}

/** 演员语料条目（对应 Actor 表结构，供引擎消费） */
export interface ActorCorpusItem {
  id: string;
  name: string;
  region: ActorRegion;
  /** 难度 1-3：1 入门 / 2 进阶 / 3 骨灰 */
  difficulty: number;
  /** 代表作（作品名，不含书名号） */
  works: string[];
  /** 经典角色 */
  roles: ActorRole[];
}

/** 出题请求参数 */
export interface BuildRoundsOptions {
  /** 难度档位 EASY / NORMAL / HARD */
  difficulty: ActorDifficulty;
  /** 轮次数，默认 10 */
  count?: number;
  /** 随机种子（可复现对局，测试用） */
  seed?: number;
  /** 该玩家最近出过的素材 key（跨局防重复） */
  excludeKeys?: string[];
}

/** 难度档位 */
export enum ActorDifficulty {
  EASY = "EASY",
  NORMAL = "NORMAL",
  HARD = "HARD",
}

/** 单轮题目数据（含答案，仅服务端持有） */
export interface ActorRound {
  roundIndex: number;
  type: ActorQuestionType;
  /** 题面 */
  prompt: string;
  /** 选项（4 选 1） */
  options: string[];
  /** 正确答案索引 */
  answerIndex: number;
  /** 素材稳定 key（跨局去重，仅服务端持有，不下发） */
  sourceKey: string;
  /** 结算回顾用 */
  meta: {
    actorName: string;
    region: ActorRegion;
    /** 代表作（解析展示） */
    works: string[];
    /** 经典角色名（解析展示） */
    roles: string[];
    /** 猜作品题型：该角色名 */
    role?: string;
  };
}

/** 发给客户端的题目视图（剥离 answerIndex / meta） */
export interface ActorRoundView {
  roundIndex: number;
  type: ActorQuestionType;
  prompt: string;
  options: string[];
}

/** 难度档位对应的难度值区间（高档位包含低档位语料） */
export const DIFFICULTY_RANGE: Record<ActorDifficulty, [number, number]> = {
  [ActorDifficulty.EASY]: [1, 1],
  [ActorDifficulty.NORMAL]: [1, 2],
  [ActorDifficulty.HARD]: [1, 3],
};

/**
 * 各档位对语料难度 1/2/3 的抽题权重
 * 高档位不再被入门题淹没（骨灰关高难素材占多数），但保留少量简单题保证题量
 */
export const DIFFICULTY_WEIGHTS: Record<ActorDifficulty, [number, number, number]> = {
  [ActorDifficulty.EASY]: [1, 0.15, 0.03],
  [ActorDifficulty.NORMAL]: [0.3, 1, 0.4],
  [ActorDifficulty.HARD]: [0.08, 0.45, 1],
};

/** 地区中文标签 */
export const REGION_LABEL: Record<ActorRegion, string> = {
  [ActorRegion.MAINLAND]: "中国内地",
  [ActorRegion.HK_TW]: "中国港台",
  [ActorRegion.OVERSEAS]: "海外",
};

/** 将完整轮次转为客户端视图（剥离答案） */
export function toRoundView(round: ActorRound): ActorRoundView {
  return {
    roundIndex: round.roundIndex,
    type: round.type,
    prompt: round.prompt,
    options: round.options,
  };
}
