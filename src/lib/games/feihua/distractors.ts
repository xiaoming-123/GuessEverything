/**
 * 飞花令干扰项生成 · 纯函数
 *
 * 策略：
 * - 寻句题：3 个不含令字的诗句，优先取他诗（避免同诗连句的重复感）
 * - 挑白题：3 个含令字的诗句（直接取令字索引）
 * - 猜令题：3 个不在题干句中的候选令字
 */

import type { FeihuaSentence } from "./types";

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
export function pickDistractors<T>(
  pool: T[],
  correct: T,
  n: number,
  rand: () => number = Math.random,
): T[] {
  const candidates = [...new Set(pool)].filter((v) => v !== correct);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, n);
}

/** 从数组中随机取 n 个元素 */
export function sample<T>(list: readonly T[], n: number, rand: () => number): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

/** 不含令字的诗句池（他诗优先，同诗兜底，两段不相交） */
export function withoutCharPool(
  sentences: readonly FeihuaSentence[],
  char: string,
  targetId: string,
): FeihuaSentence[] {
  const eligible = sentences.filter(
    (s) => s.id !== targetId && !s.text.includes(char),
  );
  const otherPoem = eligible.filter((s) => !isSamePoem(s.id, targetId));
  const samePoem = eligible.filter((s) => isSamePoem(s.id, targetId));
  return [...otherPoem, ...samePoem];
}

/** 含令字的诗句池（排除目标句自身） */
export function withCharPool(
  index: Map<string, FeihuaSentence[]>,
  char: string,
  targetId: string,
): FeihuaSentence[] {
  return (index.get(char) ?? []).filter((s) => s.id !== targetId);
}

function isSamePoem(idA: string, idB: string): boolean {
  return idA.split("#")[0] === idB.split("#")[0];
}
