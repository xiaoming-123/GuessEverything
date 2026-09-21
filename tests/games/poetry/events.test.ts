/**
 * 限时事件框架 · 纯逻辑层单测（P2 详设 §2.1 / §2.5）
 *
 * 日期基准（Asia/Shanghai 日期粒度，dateKey 注入，与运行时区无关）：
 * - 2026-09-14 周一 / 09-15 周二 / 09-16 周三 / 09-17 周四 / 09-18 周五 / 09-19 周六 / 09-20 周日
 * - 2026-09-15 为周二且是 15 日 → 钦天大比（高倍率优先，重叠用例）
 */
import { describe, it, expect } from "vitest";
import {
  activeEvent,
  addDays,
  eventForDate,
  weekdayOf,
  type ActiveEventView,
} from "@/lib/games/poetry/events";

/** 上海当日 23:59:59.999 ≙ UTC 15:59:59.999（UTC+8 无夏令时） */
function endOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 15, 59, 59, 999);
}

describe("weekdayOf", () => {
  it("2026-09 周历基准", () => {
    expect(weekdayOf("2026-09-14")).toBe(1); // 周一
    expect(weekdayOf("2026-09-15")).toBe(2); // 周二
    expect(weekdayOf("2026-09-16")).toBe(3); // 周三
    expect(weekdayOf("2026-09-17")).toBe(4); // 周四
    expect(weekdayOf("2026-09-18")).toBe(5); // 周五
    expect(weekdayOf("2026-09-19")).toBe(6); // 周六
    expect(weekdayOf("2026-09-20")).toBe(0); // 周日
  });
});

describe("addDays", () => {
  it("跨月 / 平年 2 月边界", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // 2026 非闰年
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-09-16", 4 - weekdayOf("2026-09-16"))).toBe("2026-09-17");
  });
});

describe("eventForDate · 诗月圆（周二~周四 ×1.2）", () => {
  it("周二命中，窗口 endsAt 落在周四", () => {
    const e = eventForDate("2026-09-15") === null ? null : eventForDate("2026-09-16");
    // 09-16 周三（09-15 被 15 日规则抢占，见重叠用例）
    expect(e).not.toBeNull();
    const v = e as ActiveEventView;
    expect(v.id).toBe("poetry-moon");
    expect(v.name).toBe("诗月圆");
    expect(v.expMultiplier).toBe(1.2);
    expect(v.endsAt).toBe(endOf("2026-09-17")); // 周四收窗
  });

  it("周三 / 周四命中同一窗口", () => {
    for (const dk of ["2026-09-16", "2026-09-17"]) {
      const e = eventForDate(dk);
      expect(e).not.toBeNull();
      expect(e!.id).toBe("poetry-moon");
      expect(e!.endsAt).toBe(endOf("2026-09-17"));
    }
  });

  it("周一 / 周五 / 周六 / 周日 不命中", () => {
    for (const dk of ["2026-09-14", "2026-09-18", "2026-09-19", "2026-09-20"]) {
      expect(eventForDate(dk)).toBeNull();
    }
  });
});

describe("eventForDate · 钦天大比（15 日 ×1.5，高倍率优先）", () => {
  it("15 日命中钦天大比（无论星期几）", () => {
    const cases: Array<[string, number]> = [
      ["2026-09-15", 2], // 周二
      ["2026-10-15", 4], // 周四
      ["2026-11-15", 0], // 周日
      ["2026-12-15", 2], // 周二
    ];
    for (const [dk, wd] of cases) {
      expect(weekdayOf(dk)).toBe(wd); // 基准自洽
      const e = eventForDate(dk);
      expect(e).not.toBeNull();
      expect(e!.id).toBe("imperial-exam");
      expect(e!.name).toBe("钦天大比");
      expect(e!.expMultiplier).toBe(1.5);
      expect(e!.endsAt).toBe(endOf(dk)); // 窗口=当日
    }
  });

  it("15 日 ∩ 周二~四 → 钦天大比（重叠取高倍率，详设 §2.1）", () => {
    // 2026-09-15：周二 + 15 日 → imperial-exam 而非 poetry-moon
    const e = eventForDate("2026-09-15");
    expect(e!.id).toBe("imperial-exam");
    expect(e!.expMultiplier).toBe(1.5);
  });

  it("16 日 00:00 起不命中（dateKey 口径）", () => {
    expect(eventForDate("2026-09-16")!.id).toBe("poetry-moon");
    expect(eventForDate("2026-09-17")!.id).toBe("poetry-moon");
    expect(eventForDate("2026-09-18")).toBeNull();
  });
});

describe("activeEvent", () => {
  it("显式 dateKey 与 eventForDate 一致", () => {
    const now = Date.UTC(2026, 8, 16, 2, 0, 0); // 上海 09-16 10:00
    expect(activeEvent(now, "2026-09-16")!.id).toBe("poetry-moon");
  });

  it("缺省 dateKey：按 nowMs 以 Asia/Shanghai 推导", () => {
    // 上海 2026-09-17 23:30 ≙ UTC 15:30 → 周四命中
    const thuLate = Date.UTC(2026, 8, 17, 15, 30, 0);
    expect(activeEvent(thuLate)!.id).toBe("poetry-moon");
    // 上海 2026-09-18 00:10 ≙ UTC 09-17 16:10 → 周五不命中
    const friEarly = Date.UTC(2026, 8, 17, 16, 10, 0);
    expect(activeEvent(friEarly)).toBeNull();
  });

  it("事件文案不含题面 / 答案字段", () => {
    const e = eventForDate("2026-09-16")!;
    const blob = JSON.stringify(e);
    expect(blob).not.toContain("answer");
    expect(blob).not.toContain("sourceKey");
    expect(typeof e.tagline).toBe("string");
    expect(e.tagline.length).toBeGreaterThan(0);
  });
});
