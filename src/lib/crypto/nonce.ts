/**
 * nonce 防重放存储（服务端内存实现）
 *
 * 单实例部署够用；多实例部署时替换为 Redis SETNX 实现。
 */

import { NONCE_TTL_MS } from "./protocol";

const globalForNonce =
  globalThis as unknown as { __mysteryBoxNonces?: Map<string, number> };

function store(): Map<string, number> {
  globalForNonce.__mysteryBoxNonces ??= new Map();
  return globalForNonce.__mysteryBoxNonces;
}

function evictExpired(now: number): void {
  const s = store();
  for (const [nonce, ts] of s) {
    if (now - ts > NONCE_TTL_MS) s.delete(nonce);
  }
}

/**
 * 检查并占用 nonce：首次出现返回 true，重复出现视为重放
 */
export function checkAndConsumeNonce(nonce: string, now: number = Date.now()): boolean {
  const s = store();
  if (s.has(nonce)) return false;
  evictExpired(now);
  s.set(nonce, now);
  return true;
}

/** 测试辅助：清空存储 */
export function clearNonces(): void {
  store().clear();
}
