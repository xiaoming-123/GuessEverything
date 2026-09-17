/**
 * secureFetch · 客户端加密层封装（浏览器 WebCrypto 实现）
 *
 * 业务代码调用方式与 fetch 一致，全程操作明文对象：
 *   const data = await secureFetch<GameStartView>("/api/games/poetry/session", { stage, count });
 *
 * 内部自动完成：密钥交换（懒加载一次）→ AES-256-GCM 加密请求 → 解密响应。
 */

import {
  ENVELOPE_VERSION,
  Envelope,
  KeyExchangeResponse,
} from "./protocol";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const NONCE_BYTES = 16;

interface SecureSession {
  sessionId: string;
  aesKey: CryptoKey;
  /** RSA-OAEP 封装后的 AES 密钥（base64），仅首个请求携带 */
  wrappedKey: string;
  keySent: boolean;
}

let sessionPromise: Promise<SecureSession> | null = null;

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 懒加载密钥交换：客户端生成 AES 密钥并经服务端公钥封装 */
async function ensureSession(): Promise<SecureSession> {
  sessionPromise ??= (async () => {
    const res = await fetch("/api/crypto/key", { cache: "no-store" });
    if (!res.ok) throw new Error("密钥交换失败");
    const { sessionId, publicKey } = (await res.json()) as KeyExchangeResponse;

    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const aesKey = await crypto.subtle.importKey(
      "raw",
      rawKey as unknown as BufferSource,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );

    const pubKey = await crypto.subtle.importKey(
      "spki",
      base64ToBuffer(publicKey) as unknown as BufferSource,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const wrapped = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      pubKey,
      rawKey as unknown as BufferSource,
    );

    return {
      sessionId,
      aesKey,
      wrappedKey: toBase64(wrapped),
      keySent: false,
    };
  })();
  return sessionPromise;
}

function base64ToBuffer(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 会话失效时重置（下次调用重新走密钥交换） */
export function resetSecureSession(): void {
  sessionPromise = null;
}

export async function secureFetch<T>(
  path: string,
  payload?: unknown,
  method: "POST" | "PATCH" | "PUT" = "POST",
): Promise<T> {
  const session = await ensureSession();

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(JSON.stringify(payload ?? null));
  // WebCrypto GCM 输出 = ciphertext || tag（16B），需拆分以匹配服务端 Node 格式
  const cipherWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      session.aesKey,
      encoded as unknown as BufferSource,
    ),
  );
  const tagStart = cipherWithTag.length - TAG_BYTES;
  const cipherText = cipherWithTag.slice(0, tagStart);
  const tag = cipherWithTag.slice(tagStart);

  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    sessionId: session.sessionId,
    key: session.keySent ? null : session.wrappedKey,
    iv: toBase64(iv),
    tag: toBase64(tag),
    ts: Date.now(),
    nonce: randomHex(NONCE_BYTES),
    data: toBase64(cipherText),
  };
  session.keySent = true;

  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });

  if (res.status === 401) {
    // 会话过期：重置后抛错，由调用方引导用户重试
    resetSecureSession();
    throw new Error("会话已过期，请重试");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error?.message ?? "请求失败");
  }

  const respEnvelope = (await res.json()) as Envelope;

  // 服务端密文 = ciphertext（不含 tag）+ tag 分离，拼接后交 WebCrypto 解密
  const ct = base64ToBuffer(respEnvelope.data);
  const tagBuf = base64ToBuffer(respEnvelope.tag);
  const combined = new Uint8Array(ct.length + tagBuf.length);
  combined.set(ct);
  combined.set(tagBuf, ct.length);

  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBuffer(respEnvelope.iv) as unknown as BufferSource,
    },
    session.aesKey,
    combined as unknown as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
