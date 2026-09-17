/**
 * withCrypto · 服务端加密层封装
 *
 * 业务 Route Handler 全程操作明文对象：
 *   export const POST = withCrypto(async (body) => { ... });
 *
 * 内部自动完成：时效校验 → 防重放 → 密钥解封 → 信封解密 → 业务处理 → 信封加密响应。
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  CryptoError,
  ENVELOPE_VERSION,
  Envelope,
  verifyFreshness,
} from "./protocol";
import { checkAndConsumeNonce } from "./nonce";
import { resolveSessionKey } from "./session-keys";

const IV_BYTES = 12;
const NONCE_BYTES = 16;

type SecureHandler = (body: unknown) => unknown | Promise<unknown>;

/** 业务错误：带 HTTP 状态码 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function encryptWithKey(aesKey: Buffer, plain: string) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), tag: tag.toString("base64"), data: ct.toString("base64") };
}

function decryptWithKey(aesKey: Buffer, envelope: Envelope): string {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      aesKey,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    throw new CryptoError("CRYPTO_FAILED", "数据解密失败");
  }
}

function errorStatus(code: CryptoError["code"]): number {
  switch (code) {
    case "STALE_REQUEST":
    case "REPLAY_DETECTED":
      return 400;
    case "SESSION_EXPIRED":
      return 401;
    default:
      return 400;
  }
}

export function withCrypto(handler: SecureHandler) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      const envelope = (await req.json()) as Envelope;
      // 1. 时效校验（防过期重放）
      verifyFreshness(envelope);
      // 2. 防重放（nonce 一次性）
      if (!checkAndConsumeNonce(envelope.nonce)) {
        throw new CryptoError("REPLAY_DETECTED", "检测到重放请求");
      }
      // 3. 解封会话密钥（首个请求内含 RSA 封装的 AES 密钥）
      const aesKey = resolveSessionKey(envelope.sessionId, envelope.key);
      // 4. 解密业务数据
      let body: unknown = null;
      if (envelope.data) {
        body = JSON.parse(decryptWithKey(aesKey, envelope));
      }
      // 5. 业务处理（明文）
      const result = await handler(body);
      // 6. 响应加密
      const payload = encryptWithKey(aesKey, JSON.stringify(result ?? {}));
      return NextResponse.json({
        v: ENVELOPE_VERSION,
        sessionId: envelope.sessionId,
        key: null,
        ts: Date.now(),
        ...payload,
      } satisfies Omit<Envelope, "nonce">);
    } catch (err) {
      if (err instanceof CryptoError) {
        return NextResponse.json(
          { error: { code: err.code, message: err.message } },
          { status: errorStatus(err.code) },
        );
      }
      if (err instanceof ApiError) {
        return NextResponse.json(
          { error: { code: "BUSINESS_ERROR", message: err.message } },
          { status: err.status },
        );
      }
      console.error("[withCrypto] unexpected error:", err);
      return NextResponse.json(
        { error: { code: "CRYPTO_FAILED", message: "服务异常" } },
        { status: 500 },
      );
    }
  };
}

/** 生成信封所需随机 nonce（32 hex） */
export function randomNonce(): string {
  return crypto.randomBytes(NONCE_BYTES).toString("hex");
}
