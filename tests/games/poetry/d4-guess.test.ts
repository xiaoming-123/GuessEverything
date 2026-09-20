import { describe, expect, it } from "vitest";
import {
  buildGuessOptions,
  GUESS_REWARD,
  guessTargetRank,
  isGuessAvailable,
  mulberry32,
  pickHintRemoved,
} from "@/lib/games/poetry/guess";
import { RANKS } from "@/lib/games/poetry/rank";

describe("诗词升官 · D4 问同窗 + 剪影竞猜（纯逻辑）", () => {
  describe("pickHintRemoved（不泄答案）", () => {
    it("恒返回 2 个索引，且全部 ≠ answerIndex（1000 次随机断言）", () => {
      for (let t = 0; t < 1000; t += 1) {
        const answerIndex = Math.floor(Math.random() * 4);
        const rng = mulberry32(t * 1000 + 7);
        const removed = pickHintRemoved(answerIndex, 4, rng);
        expect(removed).toHaveLength(2);
        expect(removed[0]).not.toBe(removed[1]);
        expect(removed).not.toContain(answerIndex);
        for (const i of removed) {
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(4);
        }
      }
    });

    it("选项数 <4 或 answerIndex 越界抛错", () => {
      expect(() => pickHintRemoved(0, 3, mulberry32(1))).toThrow(RangeError);
      expect(() => pickHintRemoved(4, 4, mulberry32(1))).toThrow(RangeError);
    });

    it("确定性：同 seed 同 answerIndex 同结果", () => {
      const a = pickHintRemoved(1, 4, mulberry32(42));
      const b = pickHintRemoved(1, 4, mulberry32(42));
      expect(a).toEqual(b);
    });

    it("answerIndex 在 0..3 各位置下，移除位覆盖其余 3 个里的 2 个（不遗漏/不越界）", () => {
      for (let answerIndex = 0; answerIndex < 4; answerIndex += 1) {
        const removed = pickHintRemoved(answerIndex, 4, mulberry32(99));
        const expectable = [0, 1, 2, 3].filter((i) => i !== answerIndex);
        for (const i of removed) expect(expectable).toContain(i);
      }
    });
  });

  describe("剪影竞猜（猜 rankId+2 迷雾阶）", () => {
    it("rankId 0..7 可猜，rankId>=8 不可猜（review A3 侍郎及以上入口隐藏）", () => {
      for (let r = 0; r < 8; r += 1) expect(isGuessAvailable(r)).toBe(true);
      for (let r = 8; r <= 10; r += 1) expect(isGuessAvailable(r)).toBe(false);
    });

    it("guessTargetRank 返回 rankId+2 官阶", () => {
      expect(guessTargetRank(0)?.label).toBe(RANKS[2].label);
      expect(guessTargetRank(3)?.label).toBe(RANKS[5].label);
      expect(guessTargetRank(7)?.label).toBe(RANKS[9].label); // 丞相
      expect(guessTargetRank(8)).toBeNull(); // 越界（>=8 隐藏）
    });

    it("buildGuessOptions 产出 4 个互异称号，含真答案", () => {
      const res = buildGuessOptions(0, 123);
      expect(res).not.toBeNull();
      expect(res!.options).toHaveLength(4);
      expect(new Set(res!.options).size).toBe(4);
      expect(res!.options).toContain(res!.answerLabel);
      // 真答案 = rankId+2 = RANKS[2].label
      expect(res!.answerLabel).toBe(RANKS[2].label);
    });

    it("确定性：同 rankId+seed 同选项序（可单测、客户端渲染池）", () => {
      const a = buildGuessOptions(3, 55);
      const b = buildGuessOptions(3, 55);
      expect(a!.options).toEqual(b!.options);
    });

    it("rankId>=8 时 buildGuessOptions 返回 null", () => {
      expect(buildGuessOptions(8, 1)).toBeNull();
      expect(buildGuessOptions(10, 1)).toBeNull();
    });

    it("GUESS_REWARD = 100（猜中 +100 功名，不走 0.8 折价）", () => {
      expect(GUESS_REWARD).toBe(100);
    });
  });
});
