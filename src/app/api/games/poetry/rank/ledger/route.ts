import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/crypto/with-crypto";
import { getLedgerView } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 功名簿视图（详设 §2.4，GET 明文）：
 * 成就宫格（badges key 集）/ 月历（daily）/ 功名总览（totalExp / seenCount / 近 10 局柱状图）。
 * 只读接口，与 /api/games/poetry/rank 同口径走明文 GET，不进加密信封。
 */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId");
  try {
    const view = await getLedgerView(playerId ?? "");
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: { code: "BUSINESS_ERROR", message: err.message } },
        { status: err.status },
      );
    }
    console.error("[rank-ledger] unexpected error:", err);
    return NextResponse.json(
      { error: { code: "SERVER_ERROR", message: "服务异常" } },
      { status: 500 },
    );
  }
}
