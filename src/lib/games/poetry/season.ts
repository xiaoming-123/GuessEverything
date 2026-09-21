/**
 * 诗词升官 · 赛季 · 纯逻辑层（零依赖，P3 详设 §2.2）
 *
 * 赛季 = 自然季度（Asia/Shanghai），键 `YYYY-Qn`（定宽，字典序即时间序）。
 * 纯函数派生，零运维零开关（与限时事件同纪律）。
 *
 * 语义（详设 §2.1 拍板）：只重置榜单维度 seasonExp，totalExp/rank/成就常青不清零
 * ——功名只增不减红线不破，seasonExp 是独立计数。
 *
 * 本文件零框架依赖：不 import next/*、@prisma/client、react、任何 IO。
 */

/** dateKey（YYYY-MM-DD，Asia/Shanghai 口径）→ 赛季键 "YYYY-Qn" */
export function seasonKeyForDate(dateKey: string): string {
  const y = dateKey.slice(0, 4);
  const m = Number(dateKey.slice(5, 7));
  if (!Number.isFinite(m) || m < 1 || m > 12) {
    throw new RangeError(`非法 dateKey: ${dateKey}`);
  }
  return `${y}-Q${Math.ceil(m / 3)}`;
}

/**
 * 赛季键 → 展示文案（朴素纪年，不造历法宣称——详设 §2.2 拍板）。
 * 迁移前的旧档 seasonKey = "v1"（常青榜时期）→ 「常青纪元」；其余非法键原样返回。
 */
export function seasonLabel(seasonKey: string): string {
  if (seasonKey === LEGACY_SEASON_KEY) return "常青纪元";
  const m = /^(\d{4})-Q([1-4])$/.exec(seasonKey);
  if (!m) return seasonKey;
  return `${m[1]} 年第${["一", "二", "三", "四"][Number(m[2]) - 1]}季度`;
}

/** 旧档赛季键（季度制启用前 PlayerRank.seasonKey 默认值，非季度格式） */
export const LEGACY_SEASON_KEY = "v1";

/** 赛季键先后比较（定宽 YYYY-Qn，字典序即时间序）；a 早于 b ⟺ true */
export function isSeasonBefore(a: string, b: string): boolean {
  return a < b;
}
