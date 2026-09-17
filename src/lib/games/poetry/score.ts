/**
 * 连击计分 · 纯函数
 *
 * 规则：
 * - 答对基础分 100
 * - 连击倍率：1 + min(combo, 5) * 0.2（第 1 连击 1.2x，封顶 2.0x）
 * - 速度奖励：5s 内答满 +20，线性衰减至 20s 归零
 * - 答错连击清零，不得分
 */

export interface ScoreInput {
  correct: boolean;
  /** 当前连击数（答对本题后的新连击数） */
  combo: number;
  /** 答题耗时 ms */
  timeMs: number;
}

export interface ScoreResult {
  gained: number;
  multiplier: number;
}

const BASE_SCORE = 100;
const MAX_COMBO_BONUS = 5;
const COMBO_STEP = 0.2;
const FAST_MS = 5000;
const SLOW_MS = 20000;
const FAST_BONUS = 20;

export function computeScore({ correct, combo, timeMs }: ScoreInput): ScoreResult {
  if (!correct) return { gained: 0, multiplier: 0 };

  const multiplier =
    1 + Math.min(combo, MAX_COMBO_BONUS) * COMBO_STEP;
  const clamped = Math.max(0, Math.min(timeMs, SLOW_MS));
  const speedBonus = Math.round(
    clamped <= FAST_MS
      ? FAST_BONUS
      : FAST_BONUS * (1 - (clamped - FAST_MS) / (SLOW_MS - FAST_MS)),
  );

  return {
    gained: Math.round(BASE_SCORE * multiplier) + speedBonus,
    multiplier,
  };
}
