/**
 * 诗词升官 · 问同窗（hint）+ 剪影竞猜（guess）· 纯逻辑层（零依赖）
 *
 * 红线（详设 §4）：
 * - hint 不泄答案：被移除的 2 个选项索引全部 ≠ answerIndex（单测 1000 次随机断言）；
 * - guess 猜 rankId+2（迷雾阶，称号被 ？？？ 遮住的阶）——rankId>=8 时入口整体隐藏（review A3）。
 *
 * 本文件零框架依赖：不 import next/*、prisma、react、任何 IO，
 * 随机源 / 官阶表一律参数注入，可独立单测、可移植小程序。
 */

import { RANKS, type RankSpec } from "./rank";

/** 剪影竞猜功名奖励（猜中 +100；不走 0.8 折价——提示代价只作用对局） */
export const GUESS_REWARD = 100;

/** 剪影竞猜上限（review A3）：rankId >= 8（侍郎及以上）时入口整体隐藏 */
export const GUESS_RANK_CEILING = 8;

/** 某官阶是否可参与剪影竞猜（rankId < 8；侍郎及以上 rankId+2 越界/触及皇帝） */
export function isGuessAvailable(rankId: number): boolean {
  return Number.isInteger(rankId) && rankId >= 0 && rankId < GUESS_RANK_CEILING;
}

/**
 * 剪影竞猜的目标官阶（rankId+2 迷雾阶，称号被 ？？？ 遮住）。
 * rankId+2 越界（>= RANKS.length）时返回 null——调用方应在 isGuessAvailable 已把关。
 */
export function guessTargetRank(rankId: number): RankSpec | null {
  if (!isGuessAvailable(rankId)) return null;
  const idx = rankId + 2;
  return idx < RANKS.length ? RANKS[idx] : null;
}

/**
 * 剪影竞猜选项池（4 个称号：真答案 + 3 个干扰称号）。
 * 干扰称号从 RANKS 其他阶取，用 seed 确定性洗牌（可单测、同 seed 同序）。
 * 服务端不下发选项池——前端自行渲染本函数产出，服务端仅收 guessLabel 比对。
 *
 * @returns { options: 4 个称号（已洗牌）, answerLabel: 真答案称号 }
 */
export function buildGuessOptions(
  rankId: number,
  seed: number,
): { options: string[]; answerLabel: string } | null {
  const target = guessTargetRank(rankId);
  if (!target) return null;
  // 候选池：真答案 + 其他 7 个（避开皇帝 label 之外都可作干扰——干扰只是「另一个官衔称号」，
  // 皇帝称号在 rankId<8 时不会进入干扰（rankId+2<=9，干扰取全表含皇帝也可，但避免露皇帝更稳：
  // 排除 isEmperor 阶，从其余 10 阶里取 3 干扰）
  const answerLabel = target.label;
  const pool = RANKS.filter((r) => !r.isEmperor && r.label !== answerLabel);
  const distractors = takeShuffled(pool, seed, 3).map((r) => r.label);
  const options = [...distractors, answerLabel];
  return { options: shuffleLabels(options, seed + 1), answerLabel };
}

/** 问同窗：从一轮的 4 个选项里挑 2 个**错误**索引（全部 ≠ answerIndex，互不相同）。
 *  纯函数：给定 answerIndex / 选项数 / 随机源，确定性产出被移除索引（可单测）。 */
export function pickHintRemoved(
  answerIndex: number,
  optionsCount: number,
  rng: () => number,
): number[] {
  if (optionsCount < 4 || answerIndex < 0 || answerIndex >= optionsCount) {
    throw new RangeError("pickHintRemoved：选项数须 >=4 且 answerIndex 合法");
  }
  const candidates: number[] = [];
  for (let i = 0; i < optionsCount; i += 1) {
    if (i !== answerIndex) candidates.push(i);
  }
  // Fisher-Yates 取前 2
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, 2).sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* 内部工具（mulberry32 确定性 PRNG，seed 派生）                        */
/* ------------------------------------------------------------------ */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function takeShuffled<T>(arr: T[], seed: number, n: number): T[] {
  const rng = mulberry32(seed);
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

function shuffleLabels(labels: string[], seed: number): string[] {
  const rng = mulberry32(seed);
  const copy = [...labels];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
