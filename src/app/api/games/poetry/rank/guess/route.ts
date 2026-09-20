import { withCrypto } from "@/lib/crypto/with-crypto";
import { submitRankGuess } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 剪影竞猜（D4 详设 §4.2，review A3）：每日 1 次，猜 rankId+2 迷雾阶称号。
 * 入参 `{ playerId, guessLabel }`；出参 `{ correct, gained, todayUsed }`。
 * 409 今日已猜（重查返回原结果由幂等键保证）/ 403 rankId>=8 无迷雾阶可猜。
 * 猜中 +100 功名（不走 0.8 折价）。
 */
export const POST = withCrypto(async (body) => {
  const { playerId, guessLabel } = (body ?? {}) as {
    playerId?: string;
    guessLabel?: string;
  };
  return submitRankGuess({ playerId, guessLabel });
});
