import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/crypto/with-crypto";
import { getRankView } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 查官阶视图（功名条 / 路线图数据源）。
 * 只读接口，走明文 GET（与 /api/leaderboard 一致），不进加密信封。
 */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId");
  try {
    const view = await getRankView(playerId ?? "");
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: { code: "BUSINESS_ERROR", message: err.message } },
        { status: err.status },
      );
    }
    console.error("[rank-view] unexpected error:", err);
    return NextResponse.json(
      { error: { code: "SERVER_ERROR", message: "服务异常" } },
      { status: 500 },
    );
  }
}
