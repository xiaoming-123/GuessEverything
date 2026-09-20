/**
 * 每日题 · 补签（streak freeze）服务端逻辑（详设 §2.1 时序 4，review A10）
 *
 * 校验口径：
 * ① date 属「上一个自然月」且该日 PlayerDaily 不存在或 settled=false（真实过期缺答）；
 * ② 本自然月补签配额未用尽（`playerDaily.count({ playerId, 本月前缀, madeUp: true }) < 1`）。
 * 通过后 upsert 该日 `{ settled: true, madeUp: true }`。
 * **不加功名**（纯展示奖励，防刷）；只影响月历 cells 状态与周连满判定。
 */
import { prisma } from "./prisma";
import { ApiError } from "@/lib/crypto/with-crypto";
import {
  buildMonthCells,
  completedWeeksThisMonth,
  MONTHLY_MAKEUP_QUOTA,
  WEEKLY_BONUS_PER_WEEK,
  type DailyView,
} from "@/lib/games/poetry/weekly";

/** 服务端本地日历日（Asia/Shanghai，YYYY-MM-DD） */
function localDate(d = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 上一自然月前缀 YYYY-MM（基于 Asia/Shanghai 本地日） */
function previousMonthPrefix(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1)); // 上月 1 号
  const py = d.getUTCFullYear();
  const pm = d.getUTCMonth() + 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/**
 * 补签（POST /api/games/poetry/rank/makeup 业务逻辑）。
 * 返回补签后的月历视图（客户端可直接刷新）。
 */
export async function makeUpDaily(playerId: string, date?: string): Promise<DailyView & { made: boolean; date: string }> {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "date 格式须为 YYYY-MM-DD");
  }
  const today = localDate();
  const prevPrefix = previousMonthPrefix(today);

  // ① date 必须属上一自然月
  if (date.slice(0, 7) !== prevPrefix) {
    throw new ApiError(400, "补签仅支持上一自然月");
  }
  // ① date 必须早于今日（过期缺答，非未来/今日）
  if (date >= today) {
    throw new ApiError(400, "补签仅支持过期未答的历史日");
  }
  // ② 该被补月（上一自然月）的补签配额未用尽——配额按被补日期所在月计，
  //    而非「调用时本月」：玩家 9 月给 8 月补签，8 月整月配额 1 次。
  const usedPrevMonth = await prisma.playerDaily.count({
    where: { playerId, madeUp: true, date: { startsWith: prevPrefix } },
  });
  if (usedPrevMonth >= MONTHLY_MAKEUP_QUOTA) {
    throw new ApiError(403, "该月补签配额已用尽");
  }
  // ① 该日 PlayerDaily 不存在或 settled=false（真实过期缺答）
  const existing = await prisma.playerDaily.findUnique({
    where: { playerId_date: { playerId, date } },
  });
  if (existing && existing.settled && !existing.madeUp) {
    throw new ApiError(409, "该日已作答，无需补签");
  }

  // upsert 置 settled=true + madeUp=true（不加功名）
  await prisma.playerDaily.upsert({
    where: { playerId_date: { playerId, date } },
    create: { playerId, date, sessionId: "", settled: true, madeUp: true },
    update: { settled: true, madeUp: true },
  });

  // 返回补签后月历视图（复用 buildDailyView）
  const view = await buildDailyView(playerId);
  return { ...view, made: true, date };
}

/** 构建当月每日题月历视图（与 rank-service.buildRankView 内联的 daily 同口径） */
export async function buildDailyView(playerId: string): Promise<DailyView> {
  const today = localDate();
  const [ty, tm] = today.slice(0, 8).split("-").map(Number);
  const todayD = Number(today.slice(8));
  const mondayOfToday =
    Date.UTC(ty, tm - 1, todayD) -
    (((new Date(Date.UTC(ty, tm - 1, todayD)).getUTCDay() || 7) - 1) * 86400000);
  const windowStart = mondayOfToday - 8 * 7 * 86400000;
  const startStr = new Date(windowStart).toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();

  const [monthRecords, historyRecords] = await Promise.all([
    prisma.playerDaily.findMany({
      where: { playerId, date: { gte: monthStart } },
      select: { date: true, settled: true, madeUp: true },
    }),
    prisma.playerDaily.findMany({
      where: { playerId, date: { gte: startStr } },
      select: { date: true, settled: true, madeUp: true },
    }),
  ]);
  const madeUpThisMonth = monthRecords.filter((r) => r.madeUp).length;
  const weeksThisMonth = completedWeeksThisMonth(historyRecords, today);
  return {
    cells: buildMonthCells({ monthStart, daysInMonth, today, records: monthRecords }),
    weeksCompleted: weeksThisMonth,
    weeklyBonus: weeksThisMonth * WEEKLY_BONUS_PER_WEEK,
    makeupLeft: Math.max(0, MONTHLY_MAKEUP_QUOTA - madeUpThisMonth),
  };
}
