/**
 * 诗词升官 · 成就徽章 · 纯逻辑层（零依赖）
 *
 * 详设 §2.2：首批全 metric 型（里程碑：有意义的行动），签到类不单独建成就
 * （月历周连满只喂 WEEKLY_3 这一个里程碑）。文案在纯逻辑层，前端可直接
 * import（与 RANKS 同模式）；服务端只下发新达成 key 集。
 *
 * 判定时点：结算事务后（同一事务尾），evaluateAchievements 返回本次新达成
 * key（纯函数，可单测）。
 */

import type { RankKind } from "./types";

export interface AchievementSpec {
  /** 稳定 key */
  key: string;
  /** 称号 */
  label: string;
  /** 条件描述（未获时剪影格文案） */
  desc: string;
  /** 判定（结算事务后评估） */
  check: (ctx: AchievementCtx) => boolean;
}

/** 结算评估上下文（服务端事务内构造） */
export interface AchievementCtx {
  /** 结算前官阶 */
  rankId: number;
  /** 晋升后官阶（未晋升 = rankId） */
  newRank: number;
  /** 本局是否晋升 */
  promoted: boolean;
  /** 本局答对题数 */
  correctCount: number;
  /** 本局总题数 */
  totalRounds: number;
  /** 本局最大连击（AnswerRecord 升序扫最大连续 correct 段） */
  maxCombo: number;
  /** 已见题累计（PlayerSeenKey sourceKey 行数，事务内查） */
  seenCount: number;
  /** 历史周连满累计（DAILY 月历推导） */
  weeksCompleted: number;
  /** 本局 kind */
  kind: RankKind;
}

/** 首批 10 条成就表（key 稳定，勿重排） */
export const ACHIEVEMENTS: AchievementSpec[] = [
  {
    key: "FIRST_PRACTICE",
    label: "初窥门径",
    desc: "完成首局研习",
    check: (c) => c.kind === "PRACTICE",
  },
  {
    key: "ALL_CORRECT",
    label: "十拿九稳",
    desc: "一局全对",
    check: (c) => c.totalRounds > 0 && c.correctCount === c.totalRounds,
  },
  {
    key: "COMBO_3",
    label: "连中三元",
    desc: "单局连对 3 题",
    check: (c) => c.maxCombo >= 3,
  },
  {
    key: "RANK_1",
    label: "童生及第",
    desc: "取得童生功名",
    check: (c) => c.newRank >= 1,
  },
  {
    key: "RANK_5",
    label: "金榜题名",
    desc: "考取进士",
    check: (c) => c.newRank >= 5,
  },
  {
    key: "RANK_9",
    label: "位极人臣",
    desc: "官至丞相",
    check: (c) => c.newRank >= 9,
  },
  {
    key: "EMPEROR",
    label: "登极",
    desc: "通过皇帝登极大考",
    check: (c) => c.newRank >= 10,
  },
  {
    key: "SEEN_100",
    label: "学富五车",
    desc: "累计研习 100 题",
    check: (c) => c.seenCount >= 100,
  },
  {
    key: "SEEN_500",
    label: "诗词阁主",
    desc: "累计研习 500 题",
    check: (c) => c.seenCount >= 500,
  },
  {
    key: "WEEKLY_3",
    label: "三月连满",
    desc: "累计 3 个周连满",
    check: (c) => c.weeksCompleted >= 3,
  },
];

/** key → 成就（客户端渲染文案用） */
export const ACHIEVEMENT_BY_KEY: ReadonlyMap<string, AchievementSpec> = new Map(
  ACHIEVEMENTS.map((a) => [a.key, a]),
);

/**
 * 评估本次新达成成就（纯函数）。
 * @param ctx 结算上下文
 * @param earnedKeys 已持有 key 集（事务内查）
 * @returns 本次新达成 key（保持 ACHIEVEMENTS 表序）
 */
export function evaluateAchievements(ctx: AchievementCtx, earnedKeys: string[]): string[] {
  const earned = new Set(earnedKeys);
  const out: string[] = [];
  for (const spec of ACHIEVEMENTS) {
    if (earned.has(spec.key)) continue;
    if (spec.check(ctx)) out.push(spec.key);
  }
  return out;
}
