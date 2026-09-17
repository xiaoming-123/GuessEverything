import { describe, expect, it } from "vitest";
import { computeScore } from "@/lib/games/object/score";

describe("computeScore", () => {
  it("答错不得分", () => {
    expect(computeScore({ correct: false, combo: 3, timeMs: 1000 })).toEqual({
      gained: 0,
      multiplier: 0,
    });
  });

  it("首题答对：基础分 ×1.2 + 满速度分", () => {
    const r = computeScore({ correct: true, combo: 1, timeMs: 3000 });
    expect(r.multiplier).toBeCloseTo(1.2);
    expect(r.gained).toBe(Math.round(100 * 1.2) + 20); // 140
  });

  it("连击倍率封顶 2.0", () => {
    const r = computeScore({ correct: true, combo: 10, timeMs: 5000 });
    expect(r.multiplier).toBe(2);
    expect(r.gained).toBe(220);
  });

  it("速度奖励随耗时线性衰减，20s 后归零", () => {
    const mid = computeScore({ correct: true, combo: 0, timeMs: 12500 });
    expect(mid.gained).toBe(100 + 10); // 半程奖励
    const slow = computeScore({ correct: true, combo: 0, timeMs: 60000 });
    expect(slow.gained).toBe(100);
  });
});
