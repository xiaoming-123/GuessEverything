import { withCrypto } from "@/lib/crypto/with-crypto";
import { requestHint } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 问同窗（D4 详设 §4.1）：一局一次，移除 2 个错误选项（不泄答案）。
 * 入参 `{ playerId, gameSessionId, roundIndex }`；出参 `{ removedIndexes }`。
 * 404 对局不存在 / 410 已结束或超时 / 409 本局已用过 / 400 轮次已答或越界。
 */
export const POST = withCrypto(async (body) => {
  const { playerId, gameSessionId, roundIndex } = (body ?? {}) as {
    playerId?: string;
    gameSessionId?: string;
    roundIndex?: number;
  };
  return requestHint({ playerId, gameSessionId, roundIndex });
});
