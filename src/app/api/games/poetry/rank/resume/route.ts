import { ApiError, withCrypto } from "@/lib/crypto/with-crypto";
import { resumeRankedSession } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 刷新恢复：取玩家最近一局未完成的官阶局（无则返回空对象）。
 * 有局时返回 RankedResumeView；withCrypto 对空对象照常加密下发。
 */
export const POST = withCrypto(async (body) => {
  const { playerId } = (body ?? {}) as { playerId?: string };
  if (!playerId || typeof playerId !== "string") {
    throw new ApiError(400, "参数不完整");
  }
  const resumed = await resumeRankedSession(playerId);
  return resumed ?? {};
});
