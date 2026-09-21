/**
 * 赛季纯逻辑单测（P3 详设 §2.6）
 */
import { describe, expect, it } from "vitest";
import {
  LEGACY_SEASON_KEY,
  isSeasonBefore,
  seasonKeyForDate,
  seasonLabel,
} from "@/lib/games/poetry/season";

describe("seasonKeyForDate 季度键", () => {
  it("季度边界：1/1、3/31、4/1、12/31", () => {
    expect(seasonKeyForDate("2026-01-01")).toBe("2026-Q1");
    expect(seasonKeyForDate("2026-03-31")).toBe("2026-Q1");
    expect(seasonKeyForDate("2026-04-01")).toBe("2026-Q2");
    expect(seasonKeyForDate("2026-06-30")).toBe("2026-Q2");
    expect(seasonKeyForDate("2026-07-01")).toBe("2026-Q3");
    expect(seasonKeyForDate("2026-09-21")).toBe("2026-Q3");
    expect(seasonKeyForDate("2026-10-01")).toBe("2026-Q4");
    expect(seasonKeyForDate("2026-12-31")).toBe("2026-Q4");
  });

  it("非法 dateKey 抛 RangeError", () => {
    expect(() => seasonKeyForDate("2026-13-01")).toThrow(RangeError);
    expect(() => seasonKeyForDate("2026-00-01")).toThrow(RangeError);
    expect(() => seasonKeyForDate("bad")).toThrow(RangeError);
  });
});

describe("seasonLabel 展示文案", () => {
  it("季度键 → 朴素纪年（不造历法宣称）", () => {
    expect(seasonLabel("2026-Q1")).toBe("2026 年第一季度");
    expect(seasonLabel("2026-Q3")).toBe("2026 年第三季度");
    expect(seasonLabel("2027-Q4")).toBe("2027 年第四季度");
  });

  it("legacy 键 v1 → 常青纪元", () => {
    expect(seasonLabel(LEGACY_SEASON_KEY)).toBe("常青纪元");
  });

  it("非法键原样返回（防御脏数据）", () => {
    expect(seasonLabel("2026-Q9")).toBe("2026-Q9");
    expect(seasonLabel("xxx")).toBe("xxx");
  });
});

describe("isSeasonBefore 时间序", () => {
  it("定宽键字典序即时间序", () => {
    expect(isSeasonBefore("2026-Q1", "2026-Q2")).toBe(true);
    expect(isSeasonBefore("2026-Q4", "2027-Q1")).toBe(true); // 跨年
    expect(isSeasonBefore("2027-Q1", "2026-Q4")).toBe(false);
    expect(isSeasonBefore("2026-Q3", "2026-Q3")).toBe(false); // 相等不算早于
  });
});
