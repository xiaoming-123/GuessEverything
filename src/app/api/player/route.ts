import { withCrypto, ApiError } from "@/lib/crypto/with-crypto";
import { getPlayerProfile, registerPlayer, renamePlayer } from "@/lib/db/player-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PlayerBody {
  playerId?: string;
  nickname?: string;
}

/** 注册匿名玩家（幂等：带 playerId 且存在则返回档案） */
export const POST = withCrypto(async (body) => {
  const { playerId } = (body ?? {}) as PlayerBody;
  if (playerId !== undefined && typeof playerId !== "string") {
    throw new ApiError(400, "参数不完整");
  }
  return registerPlayer({ playerId });
});

/** 改昵称 */
export const PATCH = withCrypto(async (body) => {
  const { playerId, nickname } = (body ?? {}) as PlayerBody;
  if (typeof playerId !== "string" || typeof nickname !== "string") {
    throw new ApiError(400, "参数不完整");
  }
  return renamePlayer(playerId, nickname);
});

/** 查档案（进度/昵称） */
export const PUT = withCrypto(async (body) => {
  const { playerId } = (body ?? {}) as PlayerBody;
  if (typeof playerId !== "string") throw new ApiError(400, "参数不完整");
  return getPlayerProfile(playerId);
});
