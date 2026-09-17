/**
 * 干扰项生成 · 纯函数
 *
 * 策略：
 * - 猜诗人：优先同朝代诗人，不足时从全池补齐
 * - 猜诗名：优先同诗人作品，不足时从全池补齐
 * - 补下句：优先取同诗其他句 / 同诗人其他句，不足时取同朝代诗句
 */

import type { PoemCorpusItem } from "./types";

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

/** 猜诗人：同朝代优先的干扰项池 */
export function poetDistractorPool(
  corpus: PoemCorpusItem[],
  correctPoet: string,
  correctDynasty: string,
): string[] {
  const sameDynasty = corpus
    .filter((p) => p.dynasty === correctDynasty && p.poet !== correctPoet)
    .map((p) => p.poet);
  const others = corpus
    .filter((p) => p.dynasty !== correctDynasty && p.poet !== correctPoet)
    .map((p) => p.poet);
  return [...sameDynasty, ...others];
}

/** 猜诗名：同诗人作品优先的干扰项池 */
export function titleDistractorPool(
  corpus: PoemCorpusItem[],
  correctTitle: string,
  correctPoet: string,
): string[] {
  const samePoet = corpus
    .filter((p) => p.poet === correctPoet && p.title !== correctTitle)
    .map((p) => p.title);
  const others = corpus
    .filter((p) => p.poet !== correctPoet && p.title !== correctTitle)
    .map((p) => p.title);
  return [...samePoet, ...others];
}

/** 补下句：同诗/同诗人/同朝代句子的干扰项池 */
export function nextLineDistractorPool(
  corpus: PoemCorpusItem[],
  correctPoemId: string,
  exclude: string[],
): string[] {
  const samePoem = corpus
    .filter((p) => p.id === correctPoemId)
    .flatMap((p) => p.lines)
    .filter((l) => !exclude.includes(l));
  const samePoet = corpus
    .filter((p) => p.id !== correctPoemId)
    .flatMap((p) => p.lines)
    .filter((l) => !exclude.includes(l));
  return [...samePoem, ...samePoet];
}
