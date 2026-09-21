/**
 * 诗词升官 · 皇榜（排行榜）· 纯逻辑层（零依赖）
 *
 * 详设 §4.5（docs/design/2026-09-20-poetry-rank-detailed-design.md）：
 * - 本玩法进度的**派生展示面**，不是新玩法模式；零 schema 改动。
 * - 冷启动：内置 5 个虚拟榜位（公版名人 + 架空官衔/功名，固定值），
 *   与真实数据合并排序；为低进度玩家提供追赶锚点。
 * - 排序三键：官阶 rank DESC → 功名 totalExp DESC → name ASC（稳定，防同阶同功名抖动）。
 * - 低压力展示：追赶叙事（我前面最近一位）而非精确名次全量。
 * - 架空称号不宣称真实官制。
 *
 * 本文件零框架依赖：不 import next/*、@prisma/client、react、任何 IO；
 * 只复用同目录纯逻辑常量 RANKS。
 */

import { RANKS } from "./rank";

/** 榜位条目（展示用；rankLabel 由 rank id 查 RANKS 回填，架空） */
export interface LeaderboardEntry {
  /** 展示名（真实玩家昵称 / 虚拟名人） */
  name: string;
  /** emoji 头像（虚拟与真实同规格） */
  avatar: string;
  /** 官衔称号（架空） */
  rankLabel: string;
  totalExp: number;
  /** 本赛季功名（P3-2：皇榜主排序键；虚拟位为固定赛季量级值） */
  seasonExp: number;
  /** 虚拟位标记（公版名人，固定值） */
  isVirtual: boolean;
}

/**
 * 虚拟榜位（5 个公版名人，固定官衔/功名；架空，不宣称真实官制）。
 * 功名利值（review C3）：落在对应官阶 expToReach 附近，保证「官阶为主排序」下
 * 功名与官衔自洽——翰林(48000)→52000 / 侍郎(108000)→112000 /
 * 知府(72000)→76000 / 举人(10000)→12000 / 秀才(5000)→6000。
 * seasonExp（P3-2）：压在真实玩家单季可达区间（数千~数万），冷启动锚点语义不变。
 */
export const VIRTUAL_ENTRIES: LeaderboardEntry[] = [
  { name: "李白", avatar: "🖋️", rankLabel: "翰林", totalExp: 52000, seasonExp: 18000, isVirtual: true },
  { name: "苏轼", avatar: "🍶", rankLabel: "侍郎", totalExp: 112000, seasonExp: 32000, isVirtual: true },
  { name: "辛弃疾", avatar: "⚔️", rankLabel: "知府", totalExp: 76000, seasonExp: 24000, isVirtual: true },
  { name: "王勃", avatar: "📜", rankLabel: "举人", totalExp: 12000, seasonExp: 8000, isVirtual: true },
  { name: "孟浩然", avatar: "🏞️", rankLabel: "秀才", totalExp: 6000, seasonExp: 4500, isVirtual: true },
];

/** 称号 → 官阶 id（反查；未知称号返回 -1，排序时垫底） */
function rankIdFromLabel(label: string): number {
  const r = RANKS.find((x) => x.label === label);
  return r ? r.id : -1;
}

/** 三键排序比较（P3-2：赛季榜）：seasonExp DESC → rank DESC → name ASC。a 排 b 前 ⟺ 返回 < 0 */
function cmpByOrder(
  a: { seasonExp: number; rank: number; name: string },
  b: { seasonExp: number; rank: number; name: string },
): number {
  if (a.seasonExp !== b.seasonExp) return a.seasonExp > b.seasonExp ? -1 : 1;
  if (a.rank !== b.rank) return a.rank > b.rank ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 合并排序：虚拟 + 真实，赛季功名 → 官阶 → name，截断 limit。
 * rankLabel 由 rank id 查 RANKS 表回填；虚拟位直接用内置 rankLabel。
 */
export function mergeLeaderboard(
  real: Array<{ name: string; avatar: string; rank: number; totalExp: number; seasonExp: number }>,
  limit = 100,
): LeaderboardEntry[] {
  const items = [
    ...VIRTUAL_ENTRIES.map((v) => ({ ...v, rank: rankIdFromLabel(v.rankLabel) })),
    ...real.map((r) => ({
      name: r.name,
      avatar: r.avatar,
      rankLabel: RANKS[r.rank]?.label ?? RANKS[0].label,
      totalExp: r.totalExp,
      seasonExp: r.seasonExp,
      isVirtual: false as const,
      rank: r.rank,
    })),
  ];
  // 稳定排序：三键 + 原序（虚拟位在前），同键不抖动
  items.sort((a, b) => cmpByOrder(a, b));
  return items.slice(0, limit).map(
    ({ name, avatar, rankLabel, totalExp, seasonExp, isVirtual }) => ({
      name,
      avatar,
      rankLabel,
      totalExp,
      seasonExp,
      isVirtual,
    }),
  );
}

/** 我的追赶卡（review B6：从合并列表计算，虚拟位也可能是追赶目标；P3-2 改赛季功名口径） */
export interface ChaseTarget {
  /** 我前面的人数（含虚拟位；名次 = 该值 + 1） */
  aboveCount: number;
  /** 追赶目标（我前面最近一位）展示名 */
  aboveName: string;
  /** 追赶目标官衔称号 */
  aboveLabel: string;
  /** 追赶目标本赛季功名 */
  aboveExp: number;
}

/**
 * 我的追赶卡。me = { name, rank, seasonExp }；merged = mergeLeaderboard(real, +∞)（不截断）。
 * - 我是榜首（无人排在我前）→ null。
 * - 否则返回 { aboveCount, aboveName, aboveLabel, aboveExp }。
 *
 * 实现：把 merged 每条转成可排序键（rankLabel 反查 rank），整体排序后定位 me；
 * me 紧邻上方一位即追赶目标，me 的 index 即 aboveCount。
 * me 不在 merged（real 未含我）时退化为比较法（数排在我前面的条目 + 取最接近者）。
 */
export function myChaseTarget(
  me: { name: string; rank: number; seasonExp: number },
  merged: LeaderboardEntry[],
): ChaseTarget | null {
  const meKey = { seasonExp: me.seasonExp, rank: me.rank, name: me.name };
  const keyed = merged.map((e) => ({
    entry: e,
    key: { seasonExp: e.seasonExp, rank: rankIdFromLabel(e.rankLabel), name: e.name },
  }));

  // 定位 me 在合并列表中的位置（name + seasonExp + rank 三同才认定是我）
  const meIdx = keyed.findIndex(
    (x) =>
      x.key.name === me.name &&
      x.key.seasonExp === me.seasonExp &&
      x.key.rank === me.rank,
  );

  if (meIdx >= 0) {
    if (meIdx === 0) return null; // 榜首
    const above = keyed[meIdx - 1].entry;
    return {
      aboveCount: meIdx,
      aboveName: above.name,
      aboveLabel: above.rankLabel,
      aboveExp: above.seasonExp,
    };
  }

  // me 不在 merged：比较法（数排在我前面的条目，取其中排最靠后的 = 最接近我）
  let aboveCount = 0;
  let best: { entry: LeaderboardEntry; key: (typeof keyed)[number]["key"] } | null = null;
  for (const x of keyed) {
    if (cmpByOrder(x.key, meKey) < 0) {
      aboveCount += 1;
      // 保留「排得最靠后但仍在我前面」的（cmp 值最大）
      if (best === null || cmpByOrder(x.key, best.key) > 0) {
        best = x;
      }
    }
  }
  if (aboveCount === 0 || !best) return null;
  return {
    aboveCount,
    aboveName: best.entry.name,
    aboveLabel: best.entry.rankLabel,
    aboveExp: best.entry.seasonExp,
  };
}
