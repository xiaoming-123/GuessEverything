/**
 * 诗词升官 · 每日题月历 / 周连满 · 纯逻辑层（零依赖）
 *
 * 详设 §2.1（docs/design/2026-09-20-poetry-rank-detailed-design.md）：
 * - 月历 cells：当月 1 号起、周一起排，首尾 null 补空位；
 *   状态 done=已答 / made=补签 / pending=今日未答 / future / missing=过期未答。
 * - 周连满：ISO 周口径（周一..周日 7 天全 done|made 记 1 次；跨月的周按
 *   周四所在月归属，与 YYYY-WW 键一致）。
 * - 周奖：weeksCompleted 对应档位（纯展示；补记在服务端结算事务，幂等键
 *   playerId:YYYY-WW，纯逻辑层只算档位与 ISO 周号）。
 *
 * 日期口径：本地日历日期以 YYYY-MM-DD 字符串为唯一参数形态（服务端用
 * Asia/Shanghai 生成）；本层不做任何时区换算（零 IO、可单测）。
 */

export type DailyCellState = "done" | "made" | "pending" | "future" | "missing";

export interface DailyCell {
  /** YYYY-MM-DD */
  date: string;
  state: DailyCellState;
}

export interface DailyRecord {
  /** YYYY-MM-DD */
  date: string;
  /** 是否已结算（真实作答或补签后均为 true） */
  settled: boolean;
  /** 补签标记 */
  madeUp: boolean;
}

export interface CalendarInput {
  /** 当月 1 号 YYYY-MM-DD */
  monthStart: string;
  /** 当月天数 */
  daysInMonth: number;
  /** 今日 YYYY-MM-DD */
  today: string;
  /** 当月全部 PlayerDaily 记录 */
  records: DailyRecord[];
}

/** 每日题月历视图（详设 §2.1，RankView.daily） */
export interface DailyView {
  /**
   * 当月真实天数格（review B2：弃 28 格简化月历——29-31 日无处安放且与
   * ISO 周对不齐）：当月 1 号起、周一起排，首尾 null 补空位；
   * done=已答 / made=补签 / pending=今日未答 / future / missing=过期未答
   */
  cells: Array<DailyCell | null>;
  /**
   * 本月周连满次数（ISO 周口径：周一..周日 7 天全 done|made 记 1 次；
   * 跨月的周按周四所在月归属，与 YYYY-WW 键一致）
   */
  weeksCompleted: number;
  /**
   * 本周周奖（weeksCompleted × 每周功名，纯展示；周奖功名在结算事务补记，
   * 幂等键 playerId:YYYY-WW，ISO 8601 周号）
   */
  weeklyBonus: number;
  /** 本月补签配额剩余（0 或 1） */
  makeupLeft: number;
}

/** YYYY-MM-DD → 各字段 */
function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/** 当天是周几（周一=1 .. 周日=7，ISO 口径） */
function isoDow(y: number, m: number, d: number): number {
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 日期字符串比较（YYYY-MM-DD 字典序 = 时序） */
export function dateCmp(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 当月 cells（月历格）。
 * - 首格 = 当月 1 号；若 1 号非周一，其前补 null（前月末的空位不归属本月）；
 * - 当月结束后补齐到周日，尾格 null。
 */
export function buildMonthCells(input: CalendarInput): Array<DailyCell | null> {
  const [y, m] = parts(input.monthStart);
  const cells: Array<DailyCell | null> = [];
  const stateOf = (day: number): DailyCellState => {
    const date = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const rec = input.records.find((r) => r.date === date);
    if (rec && rec.settled) return rec.madeUp ? "made" : "done";
    if (dateCmp(date, input.today) < 0) return "missing";
    if (dateCmp(date, input.today) === 0) return "pending";
    return "future";
  };
  const lead = isoDow(y, m, 1) - 1; // 1 号前的空位数
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= input.daysInMonth; day++) {
    cells.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, state: stateOf(day) });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * ISO 8601 周号键 YYYY-Www（周四归属法：本周周四所在年/周决定键）。
 * 纯 Date.UTC 计算，零 IO 可单测（对照 known-vector 断言）。
 */
export function isoWeekKey(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7; // Mon=1 .. Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // 移到本周周四
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * 周连满次数（给定历史日记录集合，统计已完结的 ISO 周中 7 天全 done|made 的次数）。
 * 「已完结周」= 周日早于今日的周；未完结周不计（本周进行中）。
 * records 需覆盖所查周的全部日期（调用方保证查数范围足够，服务端 8 周窗口）。
 * 回扫窗口从「本周的周一」往前对齐（today 不一定是周一）。
 */
export function completedWeeks(records: DailyRecord[], today: string, backWeeks = 8): string[] {
  const byDate = new Map<string, DailyRecord>(records.map((r) => [r.date, r]));
  const full = (date: string): boolean => {
    const r = byDate.get(date);
    return !!r && r.settled;
  };
  const fmt = (d: Date): string =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate(),
    ).padStart(2, "0")}`;
  const [ty, tm, td] = parts(today);
  const todayMs = Date.UTC(ty, tm - 1, td);
  // 本周周一
  const tDow = isoDow(ty, tm, td);
  const thisMonday = todayMs - (tDow - 1) * 86400000;
  const out: string[] = [];
  for (let back = 1; back <= backWeeks; back++) {
    const mondayMs = thisMonday - back * 7 * 86400000;
    let ok = true;
    for (let i = 0; i < 7; i++) {
      if (!full(fmt(new Date(mondayMs + i * 86400000)))) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(isoWeekKey(new Date(mondayMs).getUTCFullYear(), new Date(mondayMs).getUTCMonth() + 1, new Date(mondayMs).getUTCDate()));
  }
  return out;
}

/**
 * 本月周连满次数（月历展示口径）：回扫窗口内连满周中，
 * ISO 周键（YYYY-Www）的年份与本周所在的「自然月」一致时计数
 * （跨月周按周四所在月归属，与 YYYY-WW 键天然一致）。
 */
export function completedWeeksThisMonth(records: DailyRecord[], today: string): number {
  const [ty, tm] = parts(today);
  // 本月覆盖的 ISO 周键集合（逐日取 isoWeekKey，跨月周按周四归属自动归位）
  const monthWeeks = new Set<string>();
  const days = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    monthWeeks.add(isoWeekKey(ty, tm, d));
  }
  return completedWeeks(records, today).filter((k) => monthWeeks.has(k)).length;
}

/** 周奖档位（纯展示）：周连满次数 → 每周功名 */
export const WEEKLY_BONUS_PER_WEEK = 200;

/** 本月补签配额 */
export const MONTHLY_MAKEUP_QUOTA = 1;
