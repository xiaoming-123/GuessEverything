/**
 * 加密协议共享类型（客户端 / 服务端共用，零依赖）
 *
 * 信封结构：
 * - 会话密钥：客户端生成 AES-256 密钥，经服务端 RSA-2048-OAEP 公钥封装后随首个请求下发
 * - 业务数据：AES-256-GCM 加密，密文与 tag 分离传输
 * - 防重放：ts 时间戳 + nonce 一次性随机数
 */

export const ENVELOPE_VERSION = 1;

/** 最大时钟偏移：超过视为过期请求 */
export const MAX_CLOCK_SKEW_MS = 2 * 60_000;

/** 会话密钥服务端缓存时长 */
export const SESSION_KEY_TTL_MS = 30 * 60_000;

/** nonce 防重放记录时长 */
export const NONCE_TTL_MS = 5 * 60_000;

export interface Envelope {
  v: number;
  /** 密钥交换时服务端签发的会话 ID */
  sessionId: string;
  /** base64(RSA-OAEP-SHA256(AES-256 密钥))，仅会话首个请求携带 */
  key: string | null;
  /** base64 AES-GCM IV（12 字节） */
  iv: string;
  /** base64 AES-GCM auth tag（16 字节） */
  tag: string;
  /** 客户端时间戳 epoch ms */
  ts: number;
  /** 一次性随机数（32 hex） */
  nonce: string;
  /** base64 密文（不含 tag） */
  data: string;
}

/** 密钥交换响应（明文，唯一不经加密的接口） */
export interface KeyExchangeResponse {
  sessionId: string;
  /** base64(SPKI DER) RSA-2048-OAEP-SHA256 公钥 */
  publicKey: string;
}

export type CryptoErrorCode =
  | "ENVELOPE_INVALID"
  | "STALE_REQUEST"
  | "REPLAY_DETECTED"
  | "SESSION_EXPIRED"
  | "CRYPTO_FAILED";

export class CryptoError extends Error {
  constructor(
    public readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CryptoError";
  }
}

/** 校验信封时效（防过期重放） */
export function verifyFreshness(envelope: Envelope, now: number = Date.now()): void {
  if (
    !envelope ||
    envelope.v !== ENVELOPE_VERSION ||
    typeof envelope.ts !== "number" ||
    typeof envelope.nonce !== "string" ||
    envelope.nonce.length === 0
  ) {
    throw new CryptoError("ENVELOPE_INVALID", "信封格式非法");
  }
  if (Math.abs(now - envelope.ts) > MAX_CLOCK_SKEW_MS) {
    throw new CryptoError("STALE_REQUEST", "请求已过期，请刷新重试");
  }
}
