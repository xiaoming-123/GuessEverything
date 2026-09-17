import { NextRequest, NextResponse } from "next/server";

import { ApiError } from "@/lib/crypto/with-crypto";
import { getLeaderboard } from "@/lib/db/player-service";
import { STAGE_ORDER, type GameMode } from "@/lib/games/stages";
import { isDbAvailable } from "@/lib/db/db-available";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 排行榜（公开数据，明文 GET，30s 边缘缓存）
 * /api/leaderboard?mode=POETRY&stage=PRIMARY&playerId=cuid
 */
export async function GET(req: NextRequest) {
  try {
    const mode = req.nextUrl.searchParams.get("mode") as GameMode | null;
    const stage = req.nextUrl.searchParams.get("stage");
    const mePlayerId = req.nextUrl.searchParams.get("playerId") ?? undefined;

    if (!mode || !(mode in STAGE_ORDER)) throw new ApiError(400, "未知模式");
    const stages = STAGE_ORDER[mode];
    const targetStage = stage && stages.includes(stage) ? stage : stages[0];

    if (!(await isDbAvailable())) throw new ApiError(503, "DB_UNAVAILABLE");
    const data = await getLeaderboard(mode, targetStage, mePlayerId);
    return NextResponse.json(data, {
      status: 200,
      headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : "INTERNAL";
    return NextResponse.json({ error: message }, { status });
  }
}
