/**
 * 玩家 / 进度 / 排行榜 · 数据服务层
 *
 * 强依赖数据库（玩家与进度只在 DB 持久化）；
 * 内存兜底模式下相关接口返回 DB_UNAVAILABLE。
 */

import { ApiError } from "@/lib/crypto/with-crypto";
import { prisma } from "@/lib/db/prisma";
import { isDbAvailable } from "@/lib/db/db-available";
import { STAGE_ORDER, type GameMode } from "@/lib/games/stages";

const NICKNAME_ADJ = ["飞花", "妙笔", "锦鲤", "青云", "摘星", "知否", "行远", "望月", "听风", "少年"];
const NICKNAME_NOUN = ["新人", "秀才", "举人", "探花", "榜眼", "状元", "学神", "大触", "高手", "达人"];
const AVATARS = ["🐱", "🦊", "🐼", "🐸", "🦁", "🐯", "🐰", "🐵", "🦉", "🐺", "🐙", "🦋"];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 随机昵称：形容词 + 名词 + 4 位数字，如「摘星新人 4832」 */
export function randomNickname(): string {
  return `${pick(NICKNAME_ADJ)}${pick(NICKNAME_NOUN).trim()} ${Math.floor(1000 + Math.random() * 9000)}`;
}

async function assertDb() {
  if (!(await isDbAvailable())) throw new ApiError(503, "DB_UNAVAILABLE");
}

/** 注册匿名玩家；带 playerId 且存在时幂等返回档案 */
export async function registerPlayer(input: { playerId?: string }) {
  assertDb();
  if (input.playerId) {
    const existing = await prisma.player.findUnique({
      where: { id: input.playerId },
      include: { progresses: true },
    });
    if (existing) return existing;
  }
  return prisma.player.create({
    data: { nickname: randomNickname(), avatar: pick(AVATARS) },
    include: { progresses: true },
  });
}

/** 改昵称（2-12 可见字符，去除首尾空白） */
export async function renamePlayer(playerId: string, nickname: string) {
  assertDb();
  const name = nickname.trim();
  if (name.length < 2 || name.length > 12) {
    throw new ApiError(400, "昵称需 2-12 个字符");
  }
  try {
    return await prisma.player.update({
      where: { id: playerId },
      data: { nickname: name },
      include: { progresses: true },
    });
  } catch {
    throw new ApiError(404, "玩家不存在");
  }
}

export async function getPlayerProfile(playerId: string) {
  assertDb();
  const p = await prisma.player.findUnique({
    where: { id: playerId },
    include: { progresses: true },
  });
  if (!p) throw new ApiError(404, "玩家不存在");
  return p;
}

export interface UpdateProgressInput {
  playerId: string;
  mode: GameMode;
  stage: string;
  score: number;
  accuracyPercent: number;
  stars: number;
  passed: boolean;
}

/** 结算后更新关卡进度（各维度取历史最优） */
export async function updateProgress(input: UpdateProgressInput) {
  assertDb();
  const key = { playerId_mode_stage: { playerId: input.playerId, mode: input.mode, stage: input.stage } };
  const existing = await prisma.playerProgress.findUnique({ where: key });
  if (!existing) {
    return prisma.playerProgress.create({
      data: {
        playerId: input.playerId,
        mode: input.mode,
        stage: input.stage,
        bestScore: input.score,
        bestAccuracy: input.accuracyPercent,
        stars: input.stars,
      },
    });
  }
  return prisma.playerProgress.update({
    where: key,
    data: {
      bestScore: Math.max(existing.bestScore, input.score),
      bestAccuracy: Math.max(existing.bestAccuracy, input.accuracyPercent),
      stars: Math.max(existing.stars, input.stars),
    },
  });
}

/** 校验玩家某关卡已解锁（开局防作弊强制），未解锁抛 403 */
export async function assertStageUnlocked(playerId: string, mode: GameMode, stage: string) {
  assertDb();
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { progresses: { where: { mode }, select: { stage: true, stars: true } } },
  });
  if (!player) throw new ApiError(404, "玩家不存在");
  const order = STAGE_ORDER[mode];
  const index = order.indexOf(stage);
  if (index < 0) throw new ApiError(400, "未知关卡");
  if (index === 0) return;
  const prevStage = order[index - 1];
  const prev = player.progresses.find((p) => p.stage === prevStage);
  if ((prev?.stars ?? 0) < 1) throw new ApiError(403, "关卡未解锁");
}

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  nickname: string;
  avatar: string;
  bestScore: number;
}

export interface LeaderboardResult {
  mode: GameMode;
  stage: string;
  top: LeaderboardRow[];
  me: LeaderboardRow | null;
}

/** 排行榜：某模式某关卡的历史最高分榜（仅已完成对局），top50 + 我的排名 */
export async function getLeaderboard(
  mode: GameMode,
  stage: string,
  mePlayerId?: string,
): Promise<LeaderboardResult> {
  assertDb();
  const grouped = await prisma.gameSession.groupBy({
    by: ["playerId"],
    where: { mode, stage, status: "FINISHED", playerId: { not: null } },
    _max: { score: true },
  });
  const scored = grouped
    .filter((g): g is typeof g & { playerId: string } => g.playerId !== null)
    .map((g) => ({ playerId: g.playerId, bestScore: g._max.score ?? 0 }))
    .sort((a, b) => b.bestScore - a.bestScore || a.playerId.localeCompare(b.playerId));

  const players = await prisma.player.findMany({
    where: { id: { in: scored.map((s) => s.playerId) } },
    select: { id: true, nickname: true, avatar: true },
  });
  const byId = new Map(players.map((p) => [p.id, p]));

  const rows: LeaderboardRow[] = scored.map((s, i) => {
    const p = byId.get(s.playerId);
    return {
      rank: i + 1,
      playerId: s.playerId,
      nickname: p?.nickname ?? "神秘玩家",
      avatar: p?.avatar ?? "👤",
      bestScore: s.bestScore,
    };
  });

  const top = rows.slice(0, 50);
  const me = mePlayerId ? (rows.find((r) => r.playerId === mePlayerId) ?? null) : null;
  return { mode, stage, top, me };
}
