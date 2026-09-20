import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/crypto/with-crypto";
import { getLeaderboardView } from "@/lib/db/leaderboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 皇榜视图（Top 100 + 我的追赶卡，详设 §4.5）。
 * 只读接口，走明文 GET（与 /api/games/poetry/rank 一致），不进加密信封。
 */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId");
  try {
    const view = await getLeaderboardView(playerId ?? "");
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: { code: "BUSINESS_ERROR", message: err.message } },
        { status: err.status },
      );
    }
    console.error("[leaderboard-view] unexpected error:", err);
    return NextResponse.json(
      { error: { code: "SERVER_ERROR", message: "服务异常" } },
      { status: 500 },
    );
  }
}
