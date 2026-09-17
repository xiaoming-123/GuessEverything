/**
 * 会话密钥缓存（服务端）
 *
 * 客户端首个请求携带 RSA 封装的 AES 密钥，解封后按 sessionId 缓存，
 * 后续请求直接复用，TTL 过期后客户端需重新发起密钥交换。
 */

import crypto from "node:crypto";
import { CryptoError, SESSION_KEY_TTL_MS } from "./protocol";
import { getServerKeys } from "./keys";

interface SessionEntry {
  aesKey: Buffer;
  lastUsed: number;
}

const globalForSession =
  globalThis as unknown as { __mysteryBoxSessionKeys?: Map<string, SessionEntry> };

function store(): Map<string, SessionEntry> {
  globalForSession.__mysteryBoxSessionKeys ??= new Map();
  return globalForSession.__mysteryBoxSessionKeys;
}

function evictExpired(now: number): void {
  const s = store();
  for (const [id, entry] of s) {
    if (now - entry.lastUsed > SESSION_KEY_TTL_MS) s.delete(id);
  }
}

/**
 * 取回会话 AES 密钥：缓存命中直接返回；未命中则要求信封携带 RSA 封装密钥
 */
export function resolveSessionKey(
  sessionId: string,
  wrappedKey: string | null,
  now: number = Date.now(),
): Buffer {
  if (!sessionId) {
    throw new CryptoError("ENVELOPE_INVALID", "缺少 sessionId");
  }
  const s = store();
  const cached = s.get(sessionId);
  if (cached) {
    cached.lastUsed = now;
    return cached.aesKey;
  }
  if (!wrappedKey) {
    throw new CryptoError("SESSION_EXPIRED", "会话已过期，请重新进入");
  }
  const aesKey = unwrap(wrappedKey);
  evictExpired(now);
  s.set(sessionId, { aesKey, lastUsed: now });
  return aesKey;
}

/** RSA-OAEP-SHA256 解封 AES 密钥 */
function unwrap(wrappedBase64: string): Buffer {
  try {
    return crypto.privateDecrypt(
      {
        key: getServerKeys().privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(wrappedBase64, "base64"),
    );
  } catch {
    throw new CryptoError("CRYPTO_FAILED", "密钥解封失败");
  }
}

/** 密钥交换：签发新 sessionId（密钥本身由客户端持有） */
export function issueSessionId(): string {
  return crypto.randomUUID();
}

/** 测试辅助：清空缓存 */
export function clearSessionKeys(): void {
  store().clear();
}
