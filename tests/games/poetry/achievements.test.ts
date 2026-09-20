/**
 * 诗词升官 · 成就徽章 · 纯逻辑层单测
 *
 * 详设 §2.2：10 条 metric 型成就；evaluateAchievements 返回本次新达成 key
 * （纯函数，幂等——已持有 key 不再重复下发）。
 */
import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_BY_KEY,
  evaluateAchievements,
  type AchievementCtx,
} from "@/lib/games/poetry/achievements";

function ctx(patch: Partial<AchievementCtx>): AchievementCtx {
  return {
    rankId: 0,
    newRank: 0,
    promoted: false,
    correctCount: 0,
    totalRounds: 0,
    maxCombo: 0,
    seenCount: 0,
    weeksCompleted: 0,
    kind: "PRACTICE",
    ...patch,
  };
}

describe("ACHIEVEMENTS 表", () => {
  it("共 10 条，key 稳定唯一", () => {
    expect(ACHIEVEMENTS).toHaveLength(10);
    const keys = ACHIEVEMENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(10);
    expect(keys).toEqual([
      "FIRST_PRACTICE",
      "ALL_CORRECT",
      "COMBO_3",
      "RANK_1",
      "RANK_5",
      "RANK_9",
      "EMPEROR",
      "SEEN_100",
      "SEEN_500",
      "WEEKLY_3",
    ]);
  });

  it("key → 成就映射完整", () => {
    for (const a of ACHIEVEMENTS) {
      expect(ACHIEVEMENT_BY_KEY.get(a.key)?.label).toBe(a.label);
    }
  });
});

describe("evaluateAchievements（新达成判定 + 幂等）", () => {
  it("首局研习全对 3 连击 → FIRST_PRACTICE + ALL_CORRECT + COMBO_3", () => {
    const got = evaluateAchievements(
      ctx({ correctCount: 10, totalRounds: 10, maxCombo: 3 }),
      [],
    );
    expect(got).toContain("FIRST_PRACTICE");
    expect(got).toContain("ALL_CORRECT");
    expect(got).toContain("COMBO_3");
  });

  it("晋升至进士（newRank 5）→ RANK_1 + RANK_5（含低阶里程碑）", () => {
    const got = evaluateAchievements(ctx({ newRank: 5, promoted: true, kind: "EXAM" }), []);
    expect(got).toContain("RANK_1");
    expect(got).toContain("RANK_5");
    expect(got).not.toContain("RANK_9");
    expect(got).not.toContain("EMPEROR");
  });

  it("登极（newRank 10）→ 全部官阶里程碑 + EMPEROR", () => {
    const got = evaluateAchievements(ctx({ newRank: 10, promoted: true, kind: "EXAM" }), []);
    expect(got).toEqual(
      expect.arrayContaining(["RANK_1", "RANK_5", "RANK_9", "EMPEROR"]),
    );
  });

  it("已见 500 题 → SEEN_100 + SEEN_500", () => {
    const got = evaluateAchievements(ctx({ seenCount: 500 }), []);
    expect(got).toContain("SEEN_100");
    expect(got).toContain("SEEN_500");
  });

  it("周连满 3 次 → WEEKLY_3", () => {
    expect(evaluateAchievements(ctx({ weeksCompleted: 3 }), [])).toContain("WEEKLY_3");
    expect(evaluateAchievements(ctx({ weeksCompleted: 2 }), [])).not.toContain("WEEKLY_3");
  });

  it("幂等：已持有 key 不再下发（含部分持有）", () => {
    const base = ctx({ correctCount: 10, totalRounds: 10, maxCombo: 3, seenCount: 120 });
    // 全量
    const all = evaluateAchievements(base, []);
    // 持有其中 3 个 → 只下发其余
    const partial = evaluateAchievements(base, ["FIRST_PRACTICE", "ALL_CORRECT", "SEEN_100"]);
    expect(partial).not.toContain("FIRST_PRACTICE");
    expect(partial).not.toContain("ALL_CORRECT");
    expect(partial).not.toContain("SEEN_100");
    expect(new Set(partial).size).toBe(partial.length);
    expect(all.length).toBeGreaterThan(partial.length);
  });

  it("零进展结算 → 无任何新成就", () => {
    expect(evaluateAchievements(ctx({ kind: "DAILY", correctCount: 0, totalRounds: 1 }), [])).toEqual([]);
  });

  it("DAILY 局不触发 FIRST_PRACTICE（kind 口径）", () => {
    const got = evaluateAchievements(ctx({ kind: "DAILY" }), []);
    expect(got).not.toContain("FIRST_PRACTICE");
  });
});
