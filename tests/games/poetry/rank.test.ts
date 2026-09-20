import { describe, expect, it } from "vitest";
import {
  DAILY_COUNT,
  EMPEROR_COUNT,
  EMPEROR_RANK_ID,
  EXAM_COUNT,
  MAX_NORMAL_RANK_ID,
  PRACTICE_COUNT,
  RANKS,
  RANK_COUNT,
  canTakeExam,
  countFor,
  expRequiredForNextExam,
  isRankId,
  nextRank,
  preferColdFor,
  rankById,
  windowFor,
} from "@/lib/games/poetry/rank";

describe("官阶表基础结构", () => {
  it("共 10 个普通官阶 + 1 个皇帝 Boss", () => {
    expect(RANK_COUNT).toBe(11);
    expect(MAX_NORMAL_RANK_ID).toBe(9);
    expect(EMPEROR_RANK_ID).toBe(10);
    expect(rankById(EMPEROR_RANK_ID).isEmperor).toBe(true);
    expect(rankById(MAX_NORMAL_RANK_ID).isEmperor).toBeFalsy();
  });

  it("官阶 id 边界校验", () => {
    expect(isRankId(0)).toBe(true);
    expect(isRankId(9)).toBe(true);
    expect(isRankId(10)).toBe(true);
    expect(isRankId(11)).toBe(false);
    expect(isRankId(-1)).toBe(false);
    expect(isRankId(1.5)).toBe(false);
  });

  it("rankById 越界抛错，key 稳定", () => {
    expect(rankById(0).key).toBe("BUYI");
    expect(rankById(10).key).toBe("DIWANG");
    expect(() => rankById(99)).toThrow(RangeError);
    expect(() => rankById(-1)).toThrow(RangeError);
  });

  it("nextRank：布衣下一阶是童生，皇帝无下一阶", () => {
    expect(nextRank(0)?.id).toBe(1);
    expect(nextRank(9)?.id).toBe(10);
    expect(nextRank(10)).toBeNull();
  });
});

describe("功名阈值与科考资格", () => {
  it("普通官阶功名门槛严格递增（官阶难度档递增的前提）", () => {
    const thresholds = RANKS.slice(0, 10).map((r) => r.expToReach);
    for (let i = 1; i < thresholds.length; i++) {
      expect(thresholds[i]).toBeGreaterThan(thresholds[i - 1]);
    }
    expect(thresholds[0]).toBe(0); // 布衣起点无门禁
  });

  it("expRequiredForNextExam 返回下一官阶门槛", () => {
    expect(expRequiredForNextExam(0)).toBe(2000); // 童生
    expect(expRequiredForNextExam(9)).toBe(0); // 下一阶是皇帝，门槛 0（登极不靠功名靠官阶）
  });

  it("功名未达门槛不能解锁科考（边界）", () => {
    expect(canTakeExam(0, 0)).toBe(false);
    expect(canTakeExam(0, 1999)).toBe(false);
    expect(canTakeExam(0, 2000)).toBe(true);
    expect(canTakeExam(1, 4999)).toBe(false);
    expect(canTakeExam(1, 5000)).toBe(true);
  });

  it("已是皇帝不再解锁任何科考（最高阶一致）", () => {
    expect(canTakeExam(10, 999_999)).toBe(false);
  });
});

describe("官阶难度档", () => {
  it("difficulty 严格单调递增（官阶难度档递增，数据可校验）", () => {
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i].difficulty).toBeGreaterThan(RANKS[i - 1].difficulty);
    }
    expect(RANKS[0].difficulty).toBe(1);
    expect(RANKS[10].difficulty).toBe(11);
  });
});

describe("题数与窗口", () => {
  it("题数：研习/科考 10 题，每日 1 题，皇帝 Boss 15 题", () => {
    expect(PRACTICE_COUNT).toBe(10);
    expect(EXAM_COUNT).toBe(10);
    expect(DAILY_COUNT).toBe(1);
    expect(EMPEROR_COUNT).toBe(15);
    expect(countFor(0, "PRACTICE")).toBe(10);
    expect(countFor(0, "EXAM")).toBe(10);
    expect(countFor(0, "DAILY")).toBe(1);
    expect(countFor(10, "PRACTICE")).toBe(15); // 皇帝 Boss 研习 15 题
    expect(countFor(10, "EXAM")).toBe(15);
    // review A6：皇帝阶每日题恒 1 题（不烧 g12 池、不挤占登极大考）
    expect(countFor(10, "DAILY")).toBe(1);
    expect(countFor(7, "DAILY")).toBe(1);
  });

  it("窗口：科考用 examWindow，研习/每日用本官阶主窗口", () => {
    expect(windowFor(0, "PRACTICE")).toEqual([1, 3]);
    expect(windowFor(0, "DAILY")).toEqual([1, 3]);
    expect(windowFor(0, "EXAM")).toEqual([1, 4]);
    expect(windowFor(9, "PRACTICE")).toEqual([11, 12]);
    expect(windowFor(9, "EXAM")).toEqual([12, 12]);
  });

  it("窗口 grade 上、下界随官阶整体非降（难度随官阶上移）", () => {
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i].gradeWindow[0]).toBeGreaterThanOrEqual(RANKS[i - 1].gradeWindow[0]);
      expect(RANKS[i].gradeWindow[1]).toBeGreaterThanOrEqual(RANKS[i - 1].gradeWindow[1]);
    }
  });

  it("科考窗口上沿不低于研习窗口上沿（晋升大考更难一档）", () => {
    for (const r of RANKS) {
      expect(r.examWindow[1]).toBeGreaterThanOrEqual(r.gradeWindow[1]);
    }
  });

  it("高阶启用冷门优先，低阶不启用", () => {
    expect(preferColdFor(0)).toBe(false);
    expect(preferColdFor(6)).toBe(true);
    expect(preferColdFor(9)).toBe(true);
    expect(preferColdFor(10)).toBe(true);
  });
});
