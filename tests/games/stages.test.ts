import { describe, expect, it } from "vitest";

import {
  PASS_ACCURACY,
  STAGE_ORDER,
  isStageUnlocked,
  judgeClear,
  summarizeStages,
} from "@/lib/games/stages";

describe("judgeClear 星级判定", () => {
  it("边界：59% 不通关，60% 通关 1 星", () => {
    expect(judgeClear(59)).toEqual({ passed: false, stars: 0 });
    expect(judgeClear(60)).toEqual({ passed: true, stars: 1 });
  });

  it("边界：79% 1 星，80% 2 星，94% 2 星，95% 3 星", () => {
    expect(judgeClear(79).stars).toBe(1);
    expect(judgeClear(80).stars).toBe(2);
    expect(judgeClear(94).stars).toBe(2);
    expect(judgeClear(95).stars).toBe(3);
  });

  it("满分 3 星", () => {
    expect(judgeClear(100)).toEqual({ passed: true, stars: 3 });
  });

  it("越界输入收敛", () => {
    expect(judgeClear(-5)).toEqual({ passed: false, stars: 0 });
    expect(judgeClear(120)).toEqual({ passed: true, stars: 3 });
  });

  it("小数四舍五入到百分比", () => {
    expect(judgeClear(59.7).passed).toBe(true);
    expect(judgeClear(59.4).passed).toBe(false);
  });
});

describe("isStageUnlocked 解锁规则", () => {
  const poetry = STAGE_ORDER.POETRY;

  it("首关恒解锁", () => {
    expect(isStageUnlocked("POETRY", poetry[0], [])).toBe(true);
  });

  it("无进度时第二关锁定", () => {
    expect(isStageUnlocked("POETRY", poetry[1], [])).toBe(false);
  });

  it("通过前一关（stars≥1）解锁下一关", () => {
    expect(
      isStageUnlocked("POETRY", poetry[1], [{ stage: poetry[0], stars: 1, bestScore: 800 }]),
    ).toBe(true);
  });

  it("前一关有进度但 0 星不解锁", () => {
    expect(
      isStageUnlocked("POETRY", poetry[1], [{ stage: poetry[0], stars: 0, bestScore: 300 }]),
    ).toBe(false);
  });

  it("未知关卡拒绝", () => {
    expect(isStageUnlocked("POETRY", "NOPE", [])).toBe(false);
  });

  it("跨模式进度不干扰", () => {
    expect(
      isStageUnlocked("ACTOR", "EASY", [{ stage: poetry[0], stars: 3, bestScore: 999 }]),
    ).toBe(true); // ACTOR 首关
    expect(
      isStageUnlocked("ACTOR", "NORMAL", [{ stage: poetry[0], stars: 3, bestScore: 999 }]),
    ).toBe(false); // 前一关是 ACTOR/EASY
  });
});

describe("summarizeStages 结算视图", () => {
  it("输出与关卡序一致且解锁状态正确", () => {
    const s = summarizeStages("POETRY", [
      { stage: "PRIMARY", stars: 2, bestScore: 1500 },
    ]);
    expect(s).toHaveLength(3);
    expect(s[0]).toMatchObject({ stage: "PRIMARY", stars: 2, unlocked: true });
    expect(s[1]).toMatchObject({ stage: "JUNIOR", stars: 0, unlocked: true });
    expect(s[2]).toMatchObject({ stage: "SENIOR", stars: 0, unlocked: false });
  });

  it("空进度时仅首关解锁", () => {
    const s = summarizeStages("OBJECT", []);
    expect(s.filter((x) => x.unlocked)).toHaveLength(1);
  });

  it("通关门槛常量一致性", () => {
    expect(PASS_ACCURACY).toBe(60);
  });
});
