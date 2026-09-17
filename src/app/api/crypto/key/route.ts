import { NextResponse } from "next/server";
import { ENVELOPE_VERSION, KeyExchangeResponse } from "@/lib/crypto/protocol";
import { getServerKeys } from "@/lib/crypto/keys";
import { issueSessionId } from "@/lib/crypto/session-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 密钥交换：签发 sessionId + 下发 RSA 公钥
 * 唯一明文接口，业务数据全部走加密信封。
 */
export async function GET(): Promise<NextResponse<KeyExchangeResponse & { v: number }>> {
  return NextResponse.json({
    v: ENVELOPE_VERSION,
    sessionId: issueSessionId(),
    publicKey: getServerKeys().publicKeyBase64,
  });
}
