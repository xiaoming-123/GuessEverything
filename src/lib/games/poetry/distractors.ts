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

/* ------------------------------------------------------------------ */
/* D3 新题型干扰项池                                                    */
/* ------------------------------------------------------------------ */

/** 真实朝代白名单（review A1 修订）：全部真实存在过的朝代，
 *  供 DYNASTY_PICK 干扰项补位——当前语料朝代少时保证 3 个干扰可凑齐，
 *  不违背"不可能选项送分感"动机（该动机针对虚构朝代，白名单全是真实朝代）。
 *  D0 扩容 ≥5 朝代后语料内干扰自然成主流，白名单退居兜底。 */
export const DYNASTY_WHITELIST: string[] = [
  "唐",
  "宋",
  "元",
  "明",
  "清",
  "汉",
  "魏晋",
  "南北朝",
];

/**
 * DYNASTY_PICK 干扰朝代池（review A1）：
 * 正确朝代（item.dynasty）之外，① 语料内真实朝代按出现频次降序，
 * ② 不足则白名单补位（≠ correct、去重）。
 */
export function dynastyDistractorPool(
  corpus: PoemCorpusItem[],
  correctDynasty: string,
): string[] {
  // 语料内真实朝代频次（≠ correct）
  const freq = new Map<string, number>();
  for (const p of corpus) {
    if (p.dynasty === correctDynasty) continue;
    freq.set(p.dynasty, (freq.get(p.dynasty) ?? 0) + 1);
  }
  const fromCorpus = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  // 白名单补位（保持白名单序，≠ correct、不在语料已列项）
  const fromWhitelist = DYNASTY_WHITELIST.filter(
    (d) => d !== correctDynasty && !freq.has(d),
  );
  return [...fromCorpus, ...fromWhitelist];
}

/** CJK 汉字判定（\u4e00-\u9fff，非标点） */
export function isCjkChar(ch: string): boolean {
  return ch.length === 1 && ch >= "\u4e00" && ch <= "\u9fff";
}

/**
 * FILL_CHAR 挖字位候选：句中 CJK 字位索引列表。
 * 过滤条件（详设 §3.2）：该字为 CJK 汉字、句中 CJK 字数 ≥ 2（单字句不出题）。
 * 返回该句可挖的 charIndex 数组（按原句位置序）。
 */
export function fillCharPositions(line: string): number[] {
  const positions: number[] = [];
  let cjkCount = 0;
  for (let i = 0; i < line.length; i++) {
    if (isCjkChar(line[i])) cjkCount += 1;
  }
  if (cjkCount < 2) return [];
  for (let i = 0; i < line.length; i++) {
    if (isCjkChar(line[i])) positions.push(i);
  }
  return positions;
}

/**
 * FILL_CHAR 干扰字池（详设 §3.2 / §3.3）：
 * 同诗其余 CJK 字 + 同朝代其他诗 CJK 字，去重、≠ correct 字。
 * 不足 3 时 materializeRound 判该素材无效跳过（strictOptions 下弃素材）。
 */
export function charDistractorPool(
  corpus: PoemCorpusItem[],
  item: PoemCorpusItem,
  correctChar: string,
): string[] {
  const samePoemChars: string[] = [];
  const sameDynastyChars: string[] = [];
  for (const p of corpus) {
    const target = p.id === item.id ? samePoemChars : p.dynasty === item.dynasty ? sameDynastyChars : null;
    if (!target) continue;
    for (const line of p.lines) {
      for (const ch of line) {
        if (isCjkChar(ch)) target.push(ch);
      }
    }
  }
  // 去重、排除被挖字（正确字不得进干扰池，详设 §3.3）
  return [...new Set([...samePoemChars, ...sameDynastyChars])].filter((c) => c !== correctChar);
}
