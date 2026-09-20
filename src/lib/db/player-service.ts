/**
 * 玩家档案 · 数据服务层
 *
 * 强依赖数据库（玩家只在 DB 持久化）；内存兜底模式下相关接口返回 DB_UNAVAILABLE。
 * 本分支只保留诗词升官玩法：不含量关进度 / 排行榜。
 */

import { ApiError } from "@/lib/crypto/with-crypto";
import { prisma } from "@/lib/db/prisma";
import { isDbAvailable } from "@/lib/db/db-available";

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
    const existing = await prisma.player.findUnique({ where: { id: input.playerId } });
    if (existing) return existing;
  }
  return prisma.player.create({
    data: { nickname: randomNickname(), avatar: pick(AVATARS) },
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
    });
  } catch {
    throw new ApiError(404, "玩家不存在");
  }
}

export async function getPlayerProfile(playerId: string) {
  assertDb();
  const p = await prisma.player.findUnique({ where: { id: playerId } });
  if (!p) throw new ApiError(404, "玩家不存在");
  return p;
}
