/**
 * 干扰项生成 · 纯函数
 *
 * 策略：
 * - 猜演员：优先同地区演员，不足时从全池补齐
 * - 猜作品：优先同地区演员的作品，不足时从全池补齐
 */

import type { ActorCorpusItem } from "./types";

/** 带种子的伪随机数（mulberry32），保证对局可复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从候选池中随机抽取 n 个不重复且不等于正确答案的干扰项 */
export function pickDistractors(
  pool: string[],
  correct: string,
  n: number,
  rand: () => number = Math.random,
): string[] {
  const candidates = [...new Set(pool)].filter((v) => v !== correct);
  // 洗牌后取前 n 个
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, n);
}

/** 猜演员：同地区优先的干扰项池 */
export function actorDistractorPool(
  corpus: ActorCorpusItem[],
  correctName: string,
  correctRegion: string,
): string[] {
  const sameRegion = corpus
    .filter((a) => a.region === correctRegion && a.name !== correctName)
    .map((a) => a.name);
  const others = corpus
    .filter((a) => a.region !== correctRegion && a.name !== correctName)
    .map((a) => a.name);
  return [...sameRegion, ...others];
}

/** 猜作品：同地区演员作品优先的干扰项池 */
export function workDistractorPool(
  corpus: ActorCorpusItem[],
  correctWork: string,
  correctActorId: string,
  correctRegion: string,
): string[] {
  const sameRegion = corpus
    .filter((a) => a.region === correctRegion && a.id !== correctActorId)
    .flatMap((a) => a.works);
  const others = corpus
    .filter((a) => a.region !== correctRegion)
    .flatMap((a) => a.works);
  return [...sameRegion, ...others].filter((w) => w !== correctWork);
}
