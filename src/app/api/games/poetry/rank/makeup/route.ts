import { withCrypto } from "@/lib/crypto/with-crypto";
import { ApiError } from "@/lib/crypto/with-crypto";
import { makeUpDaily } from "@/lib/db/daily-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 每日题补签（详设 §2.1 时序 4，review A10）：
 * 入参 `{ playerId, date }`（date = YYYY-MM-DD，属上一个自然月、真实过期缺答、
 * 本月配额未用尽）；通过后 upsert { settled: true, madeUp: true }——
 * 不加功名（纯展示奖励，防刷），只影响月历 cells 与周连满判定。
 */
export const POST = withCrypto(
  async (body) => {
    const { playerId, date } = (body ?? {}) as { playerId?: string; date?: string };
    if (!playerId || typeof playerId !== "string") {
      throw new ApiError(400, "缺少 playerId");
    }
    return makeUpDaily(playerId, date);
  },
);
