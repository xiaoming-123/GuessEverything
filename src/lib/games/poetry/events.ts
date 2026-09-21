/**
 * 诗词升官 · 限时事件框架 · 纯逻辑层（零依赖，P2 详设 §2.1）
 *
 * 固定排期、确定性、零 DB / 零开关：
 * - 诗月圆：每周二 ~ 周四（Asia/Shanghai 日期粒度），功名 ×1.2
 * - 钦天大比：每月 15 日全天，功名 ×1.5（15 日恰为周二~四时取高倍率，id=imperial-exam）
 *
 * 日期判定全部走注入的 dateKey（YYYY-MM-DD，服务端 localDate() 同口径生成），
 * 保证可单测、可复算（结算按 GameSession.createdAt 所在日期重算，无时间轴 IO）。
 */

/** 事件视图（对外下发字段：无答案相关字段，红线不变） */
export interface ActiveEventView {
  id: string;
  name: string;
  tagline: string;
  /** 功名倍率（结算入账 round(base × expMultiplier)） */
  expMultiplier: number;
  /** 窗口结束（Asia/Shanghai 当日 23:59:59.999 的 UTC 毫秒值，客户端倒计时纯展示） */
  endsAt: number;
}

const POETRY_MOON = {
  id: "poetry-moon",
  name: "诗月圆",
  tagline: "诗月当空，学政赐功更胜一筹",
  expMultiplier: 1.2,
} as const;

const IMPERIAL_EXAM = {
  id: "imperial-exam",
  name: "钦天大比",
  tagline: "钦天诏下大比，天子赐功更为隆盛",
  expMultiplier: 1.5,
} as const;

/** 解析 dateKey（YYYY-MM-DD）→ UTC 午夜时间戳（整数日期，无时区歧义） */
function parseUtc(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** dateKey 的星期（0=周日 .. 6=周六，按日期整数判定，与运行时区无关） */
export function weekdayOf(dateKey: string): number {
  return new Date(parseUtc(dateKey)).getUTCDay();
}

/** dateKey 偏移 n 天（正负皆可） */
export function addDays(dateKey: string, n: number): string {
  const t = new Date(parseUtc(dateKey) + n * 86_400_000);
  const yy = t.getUTCFullYear();
  const mm = t.getUTCMonth() + 1;
  const dd = t.getUTCDate();
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Asia/Shanghai 某日 23:59:59.999 的 UTC 毫秒值。
 * 上海 = UTC+8 且无夏令时：当地 23:59:59.999 ≙ UTC 同日 15:59:59.999。
 */
function endOfDayShanghai(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 15, 59, 59, 999);
}

/**
 * 该日生效事件（纯函数）。
 * - 15 日 → 钦天大比（高倍率优先，窗口=当日）
 * - 周二(2) ~ 周四(4) → 诗月圆（窗口=本周二至周四，endsAt 落在周四）
 * - 其余 → null
 */
export function eventForDate(dateKey: string): ActiveEventView | null {
  const day = Number(dateKey.slice(8, 10));
  if (day === 15) {
    return { ...IMPERIAL_EXAM, endsAt: endOfDayShanghai(dateKey) };
  }
  const wd = weekdayOf(dateKey);
  if (wd >= 2 && wd <= 4) {
    const thursday = addDays(dateKey, 4 - wd);
    return { ...POETRY_MOON, endsAt: endOfDayShanghai(thursday) };
  }
  return null;
}

/**
 * 当前生效事件：dateKey 由服务端注入（localDate() 同口径）；
 * 缺省按 nowMs 以 Asia/Shanghai 推导（纯 Intl，无 IO）。
 */
export function activeEvent(nowMs: number, dateKey?: string): ActiveEventView | null {
  const dk =
    dateKey ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));
  return eventForDate(dk);
}

/** 事件 id → 展示名（纯逻辑表，客户端 HUD 徽标 / 结算行查文案用；文案与 ActiveEventView 同源） */
export const EVENT_BY_ID: Record<string, { name: string; tagline: string; expMultiplier: number }> = {
  [POETRY_MOON.id]: { name: POETRY_MOON.name, tagline: POETRY_MOON.tagline, expMultiplier: POETRY_MOON.expMultiplier },
  [IMPERIAL_EXAM.id]: { name: IMPERIAL_EXAM.name, tagline: IMPERIAL_EXAM.tagline, expMultiplier: IMPERIAL_EXAM.expMultiplier },
};
