/**
 * 诗词升官 · 皇榜（排行榜）服务（详设 §4.5）
 *
 * 定位：本玩法进度的派生只读展示面，零 schema 改动（rank/totalExp/nickname
 * 全部是服务端结算权威写入的既有数据）；防作弊随既有结算通道白捡（功名只增
 * 不减 + 会话限速）。
 *
 * - 冷启动：纯逻辑层 5 个虚拟榜位与真实数据合并排序（mergeLeaderboard）。
 * - 低压力展示：Top 100 + 我的追赶叙事（不展示全量精确名次）。
 * - 常青榜：v1 不做赛季重置（赛季化随 P2 限时事件框架）。
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
import { ApiError } from "@/lib/crypto/with-crypto";
import { isDbAvailable } from "./db-available";
import { prisma } from "./prisma";

/** 真实玩家取数上限（Top 100 展示 + 追赶卡定位容错） */
const REAL_TAKE = 200;
/** 榜单展示上限（详设 §4.5：只展示 Top 100） */
const BOARD_LIMIT = 100;

/** 皇榜视图（GET /api/games/poetry/rank/leaderboard，明文） */
export interface LeaderboardView {
  /** Top 100（虚拟 + 真实合并排序） */
  items: LeaderboardEntry[];
  /**
   * 我的位次与追赶叙事（review B6：从合并列表计算，虚拟位也可能是追赶目标）。
   * playerId 缺失 / 未注册 / 未进前 REAL_TAKE 时为 null（前端兜底「距金榜」文案）。
   */
  my: (ChaseTarget & { rankLabel: string; totalExp: number }) | null;
}

/**
 * 查皇榜视图。
 * - items = playerRank（rank DESC, totalExp DESC 取 200）与虚拟位合并，截 Top 100；
 * - my = 我在合并列表中的位次 + 我前面最近一位。
 */
export async function getLeaderboardView(playerId: string): Promise<LeaderboardView> {
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：皇榜需要数据库");

  // 真实玩家（含昵称/头像；rank/totalExp 由结算通道权威写入）
  const realRows = await prisma.playerRank.findMany({
    include: { player: { select: { nickname: true, avatar: true } } },
    orderBy: [{ rank: "desc" }, { totalExp: "desc" }],
    take: REAL_TAKE,
  });
  const real = realRows.map((r) => ({
    name: r.player?.nickname ?? "无名士",
    avatar: r.player?.avatar ?? "🙂",
    rank: r.rank,
    totalExp: r.totalExp,
  }));

  const items = mergeLeaderboard(real, BOARD_LIMIT);

  // 我的位次：未注册 / 未进前 REAL_TAKE → null（前端「距金榜」兜底）
  let my: LeaderboardView["my"] = null;
  if (playerId && typeof playerId === "string") {
    const meRow = realRows.find((r) => r.playerId === playerId);
    if (meRow) {
      const meName = meRow.player?.nickname ?? "无名士";
      const mergedFull = mergeLeaderboard(real, Infinity);
      const t = myChaseTarget(
        { name: meName, rank: meRow.rank, totalExp: meRow.totalExp },
        mergedFull,
      );
      my = {
        rankLabel: RANKS[meRow.rank]?.label ?? RANKS[0].label,
        totalExp: meRow.totalExp,
        ...(t ?? { aboveCount: 0, aboveName: "——", aboveLabel: "——", aboveExp: 0 }),
      };
    }
  }

  return { items, my };
}
