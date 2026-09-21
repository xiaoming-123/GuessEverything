/**
 * 诗词升官 · 皇榜（排行榜）服务（详设 §4.5 + P3-2 赛季化）
 *
 * 定位：本玩法进度的派生只读展示面；防作弊随既有结算通道白捡（功名只增
 * 不减 + 会话限速）。
 *
 * - 冷启动：纯逻辑层 5 个虚拟榜位与真实数据合并排序（mergeLeaderboard）。
 * - 低压力展示：Top 100 + 我的追赶叙事（不展示全量精确名次）。
 * - P3-2 赛季化：赛季 = 自然季度（seasonKeyForDate 纯函数派生，零运维）；
 *   榜按 seasonExp（本赛季功名增量）排序，totalExp/rank 常青不清零；
 *   跨赛季惰性定格（SeasonBoard.upsert 幂等）——结算事务 + 本视图双路径，
 *   覆盖「跨赛季后不结算只开皇榜」的玩家。
 *
 * 架空称号不宣称真实官制。
 */

import { RANKS } from "@/lib/games/poetry/rank";
import {
  mergeLeaderboard,
  myChaseTarget,
  type ChaseTarget,
  type LeaderboardEntry,
} from "@/lib/games/poetry/leaderboard";
import { seasonKeyForDate, seasonLabel } from "@/lib/games/poetry/season";
import { ApiError } from "@/lib/crypto/with-crypto";
import { isDbAvailable } from "./db-available";
import { prisma } from "./prisma";

/** 真实玩家取数上限（Top 100 展示 + 追赶卡定位容错） */
const REAL_TAKE = 200;
/** 榜单展示上限（详设 §4.5：只展示 Top 100） */
const BOARD_LIMIT = 100;
/** 往期战绩条数上限（P3-2 详设 §2.5） */
const PAST_LIMIT = 8;

/** 我的往期定格（SeasonBoard 快照，倒序最多 PAST_LIMIT 条） */
export interface SeasonSnapshotView {
  seasonKey: string;
  /** 展示文案（「2026 年第三季度」/「常青纪元」） */
  label: string;
  /** 定格时官衔称号（架空） */
  rankLabel: string;
  /** 定格时赛季功名 */
  seasonExp: number;
}

/** 皇榜视图（GET /api/games/poetry/rank/leaderboard，明文） */
export interface LeaderboardView {
  /** Top 100（虚拟 + 真实合并排序；P3-2 起按赛季功名） */
  items: LeaderboardEntry[];
  /**
   * 我的位次与追赶叙事（review B6：从合并列表计算，虚拟位也可能是追赶目标）。
   * playerId 缺失 / 未注册 / 未进前 REAL_TAKE 时为 null（前端兜底「距金榜」文案）。
   */
  my: (ChaseTarget & { rankLabel: string; totalExp: number; seasonExp: number }) | null;
  /** 当前赛季键（P3-2：季度制 "YYYY-Qn"；接口形状与 v1 常青榜时期不变） */
  season: string;
  /** 当前赛季展示文案（头部「2026 年第三季度榜」） */
  seasonLabel: string;
  /** 我的往期定格（无快照 = 空数组，前端不渲染往期区） */
  past: SeasonSnapshotView[];
}

/** 服务端本地日期（Asia/Shanghai，与 rank-service.localDate 同口径） */
function localDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
}

/**
 * 查皇榜视图。
 * - 惰性赛季迁移（详设 §2.4 路径 2）：取回的行中 seasonKey ≠ 当前赛季的，
 *   事务内批量 SeasonBoard.upsert 定格 + 切键清零（幂等）；
 * - items = 迁移后的当前赛季数据与虚拟位合并，截 Top 100；
 * - my = 我在合并列表中的位次 + 我前面最近一位（赛季功名口径）；
 * - past = 我的 SeasonBoard 快照倒序。
 */
export async function getLeaderboardView(playerId: string): Promise<LeaderboardView> {
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：皇榜需要数据库");

  const currentSeason = seasonKeyForDate(localDate());

  // 真实玩家（含昵称/头像；rank/totalExp/seasonExp 由结算通道权威写入）
  const realRows = await prisma.playerRank.findMany({
    include: { player: { select: { nickname: true, avatar: true } } },
    orderBy: [{ seasonExp: "desc" }, { rank: "desc" }],
    take: REAL_TAKE,
  });

  // 惰性定格（P3-2 详设 §2.4 路径 2）：跨赛季旧档 → 快照归档 + 切键清零。
  // 旧季 seasonExp=0 不落快照（无战绩留痕语义）；不活跃且从不打开皇榜的玩家
  // 不进快照（快照语义 = 定格时可见的活跃档）。
  const stale = realRows.filter((r) => r.seasonKey !== currentSeason);
  if (stale.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const r of stale) {
        if (r.seasonExp > 0) {
          await tx.seasonBoard.upsert({
            where: { seasonKey_playerId: { seasonKey: r.seasonKey, playerId: r.playerId } },
            create: {
              seasonKey: r.seasonKey,
              playerId: r.playerId,
              rank: r.rank,
              seasonExp: r.seasonExp,
            },
            update: {},
          });
        }
        await tx.playerRank.update({
          where: { playerId: r.playerId },
          data: { seasonKey: currentSeason, seasonExp: 0 },
        });
      }
    });
    // 迁移后本地视图同步（本响应立即反映新赛季口径）
    for (const r of stale) {
      r.seasonKey = currentSeason;
      r.seasonExp = 0;
    }
  }

  const real = realRows.map((r) => ({
    name: r.player?.nickname ?? "无名士",
    avatar: r.player?.avatar ?? "🙂",
    rank: r.rank,
    totalExp: r.totalExp,
    seasonExp: r.seasonExp,
  }));

  const items = mergeLeaderboard(real, BOARD_LIMIT);

  // 我的位次：未注册 / 未进前 REAL_TAKE → null（前端「距金榜」兜底）
  let my: LeaderboardView["my"] = null;
  let past: SeasonSnapshotView[] = [];
  if (playerId && typeof playerId === "string") {
    const meRow = realRows.find((r) => r.playerId === playerId);
    if (meRow) {
      const meName = meRow.player?.nickname ?? "无名士";
      const mergedFull = mergeLeaderboard(real, Infinity);
      const t = myChaseTarget(
        { name: meName, rank: meRow.rank, seasonExp: meRow.seasonExp },
        mergedFull,
      );
      my = {
        rankLabel: RANKS[meRow.rank]?.label ?? RANKS[0].label,
        totalExp: meRow.totalExp,
        seasonExp: meRow.seasonExp,
        ...(t ?? { aboveCount: 0, aboveName: "——", aboveLabel: "——", aboveExp: 0 }),
      };
    }

    // 我的往期定格（seasonKey 字典序降序 = 时间降序；legacy "v1" 天然排最后）
    const snapshots = await prisma.seasonBoard.findMany({
      where: { playerId },
      orderBy: { seasonKey: "desc" },
      take: PAST_LIMIT,
      select: { seasonKey: true, rank: true, seasonExp: true },
    });
    past = snapshots.map((s) => ({
      seasonKey: s.seasonKey,
      label: seasonLabel(s.seasonKey),
      rankLabel: RANKS[s.rank]?.label ?? RANKS[0].label,
      seasonExp: s.seasonExp,
    }));
  }

  return {
    items,
    my,
    season: currentSeason,
    seasonLabel: seasonLabel(currentSeason),
    past,
  };
}
