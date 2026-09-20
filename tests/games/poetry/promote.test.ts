import { describe, expect, it } from "vitest";
import { evaluatePromotion, type PromotionInput } from "@/lib/games/poetry/promote";

/** 默认构造：布衣(0)、功名 2000（恰好够童生门槛）、本局科考通过、目标童生(1) */
function base(over: Partial<PromotionInput> = {}): PromotionInput {
  return {
    currentRank: 0,
    totalExp: 2000,
    kind: "EXAM",
    examPassed: true,
    examRank: 1,
    ...over,
  };
}

describe("晋升判定", () => {
  it("条件齐备 → 擢升，新官阶 +1，功名进度按结果官阶前瞻", () => {
    const r = evaluatePromotion(base());
    expect(r.promoted).toBe(true);
    expect(r.newRank).toBe(1);
    expect(r.reason).toBe("PROMOTED");
    // 升到童生后，下一场科考是秀才（门槛 5000），当前功名 2000，还差 3000
    expect(r.expToNext).toBe(3000);
    expect(r.nextUnlocked).toBe(false);
  });

  it("功名恰好达到门槛（边界 2000）也能擢升", () => {
    expect(evaluatePromotion(base({ totalExp: 2000 })).promoted).toBe(true);
  });

  it("功名不足（边界 1999）不能擢升，经验不足原因", () => {
    const r = evaluatePromotion(base({ totalExp: 1999 }));
    expect(r.promoted).toBe(false);
    expect(r.newRank).toBe(0);
    expect(r.reason).toBe("EXP_INSUFFICIENT");
    // 功名保留（totalExp 仍是 1999），下一场科考还差 1
    expect(r.expToNext).toBe(1);
  });

  it("研习 / 每日题永不晋升（普通练习不能升）", () => {
    expect(evaluatePromotion(base({ kind: "PRACTICE" })).promoted).toBe(false);
    expect(evaluatePromotion(base({ kind: "DAILY" })).promoted).toBe(false);
    expect(evaluatePromotion(base({ kind: "PRACTICE" })).reason).toBe("KIND_NOT_EXAM");
  });

  it("考试目标不是下一阶 → 不擢升（越级 / 错位拒绝）", () => {
    // 布衣(0)却把科考目标设为举人(2)，越级
    expect(evaluatePromotion(base({ examRank: 2 })).promoted).toBe(false);
    expect(evaluatePromotion(base({ examRank: 2 })).reason).toBe("EXAM_TARGET_NOT_NEXT");
    // 目标低于下一阶（错位，如 0）同样拒绝
    expect(evaluatePromotion(base({ examRank: 0 })).promoted).toBe(false);
  });

  it("科考未通过 → 不擢升，功名保留（失败保留经验，不降级）", () => {
    const r = evaluatePromotion(base({ examPassed: false }));
    expect(r.promoted).toBe(false);
    expect(r.newRank).toBe(0);
    expect(r.reason).toBe("EXAM_FAILED");
    // 功名不被扣（输入多少 totalExp 就保留多少）
    expect(r.expToNext).toBe(0); // 功名 2000 已够童生门槛，差 0
  });

  it("已是皇帝（终点）不再晋升，功名进度恒 0", () => {
    const r = evaluatePromotion(base({ currentRank: 10, examRank: 11, kind: "EXAM" }));
    expect(r.promoted).toBe(false);
    expect(r.newRank).toBe(10);
    expect(r.reason).toBe("ALREADY_EMPEROR");
    expect(r.expToNext).toBe(0);
    expect(r.nextUnlocked).toBe(false);
  });

  it("丞相(9)科考通过、目标皇帝(10)、功名足够 → 擢升为皇帝", () => {
    const r = evaluatePromotion(base({ currentRank: 9, totalExp: 156000, examRank: 10 }));
    expect(r.promoted).toBe(true);
    expect(r.newRank).toBe(10);
    expect(r.reason).toBe("PROMOTED");
    // 升到皇帝（终点），下一场科考不存在，进度归 0
    expect(r.expToNext).toBe(0);
    expect(r.nextUnlocked).toBe(false);
  });

  it("功名进度前瞻：擢升后若功名已够下下一阶则 nextUnlocked=true", () => {
    // 布衣(0)→童生(1)，若功名 5000（够秀才门槛），升童生后下一场科考（秀才 5000）已解锁
    const r = evaluatePromotion(base({ totalExp: 5000 }));
    expect(r.promoted).toBe(true);
    expect(r.newRank).toBe(1);
    expect(r.expToNext).toBe(0);
    expect(r.nextUnlocked).toBe(true);
  });

  it("功名只增不减：判定不修改功名，仅按传入 totalExp 计算", () => {
    // 连续两次失败后通过，功名累计保留：1000 → 1500 → 2000 才够 2000
    const a = evaluatePromotion(base({ totalExp: 1000, examPassed: false }));
    const b = evaluatePromotion(base({ totalExp: 1500, examPassed: false }));
    const c = evaluatePromotion(base({ totalExp: 2000, examPassed: true }));
    expect(a.promoted).toBe(false);
    expect(b.promoted).toBe(false);
    expect(c.promoted).toBe(true);
    expect(c.newRank).toBe(1);
  });

  it("非法当前官阶抛 RangeError", () => {
    expect(() => evaluatePromotion(base({ currentRank: -1 }))).toThrow(RangeError);
    expect(() => evaluatePromotion(base({ currentRank: 99 }))).toThrow(RangeError);
  });
});
