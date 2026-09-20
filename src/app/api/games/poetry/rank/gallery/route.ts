import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/crypto/with-crypto";
import { getGalleryView } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 诗词阁视图（详设 §3.1，GET 明文）：
 * 玩家答过的诗（按 poemId 去重，答过即入库不论对错）。
 * 只读接口，与 /api/games/poetry/rank 同口径走明文 GET，不进加密信封。
 * 入参：playerId / page（默认 1）/ pageSize（默认 20）。
 */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId");
  const page = Number(req.nextUrl.searchParams.get("page") ?? "1");
  const pageSize = Number(req.nextUrl.searchParams.get("pageSize") ?? "20");
  const dynasty = req.nextUrl.searchParams.get("dynasty");
  const gradeRaw = req.nextUrl.searchParams.get("grade");
  const grade = gradeRaw !== null && gradeRaw !== "" ? Number(gradeRaw) : null;
  try {
    const view = await getGalleryView(playerId ?? "", page, pageSize, {
      dynasty: dynasty ?? null,
      grade,
    });
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: { code: "BUSINESS_ERROR", message: err.message } },
        { status: err.status },
      );
    }
    console.error("[rank-gallery] unexpected error:", err);
    return NextResponse.json(
      { error: { code: "SERVER_ERROR", message: "服务异常" } },
      { status: 500 },
    );
  }
}
