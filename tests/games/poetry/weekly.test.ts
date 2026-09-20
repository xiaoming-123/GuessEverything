/**
 * 诗词升官 · 每日题月历 / 周连满 · 纯逻辑层单测
 *
 * 详设 §2.1 口径：月历 cells 周一起排、首尾 null 补空；周连满 = 已完结 ISO 周
 * 7 天全 done|made；跨月周按周四所在月归属（与 YYYY-WW 键一致）。
 * 已知向量：2026-09-20 为周日（ISO 周 2026-W38）；2026-01-01 为周四（2026-W01）。
 */
import { describe, expect, it } from "vitest";
import {
  buildMonthCells,
  completedWeeks,
  completedWeeksThisMonth,
  dateCmp,
  isoWeekKey,
  type DailyRecord,
} from "@/lib/games/poetry/weekly";

/** 构造「整周 7 天全答对」记录（周一 date 起） */
function fullWeek(monday: string): DailyRecord[] {
  const [y, m, d] = monday.split("-").map(Number);
  const out: DailyRecord[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const date = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    out.push({ date, settled: true, madeUp: false });
  }
  return out;
}

describe("isoWeekKey（ISO 8601 周四归属法）", () => {
  it("已知向量：2026-09-20（周日）属 2026-W38", () => {
    expect(isoWeekKey(2026, 9, 20)).toBe("2026-W38");
  });
  it("已知向量：2026-09-21（周一）属 2026-W39（与同周 9/27 周日同键）", () => {
    expect(isoWeekKey(2026, 9, 21)).toBe("2026-W39");
    expect(isoWeekKey(2026, 9, 27)).toBe("2026-W39");
  });
  it("已知向量：2026-01-01（周四）属 2026-W01", () => {
    expect(isoWeekKey(2026, 1, 1)).toBe("2026-W01");
  });
  it("跨年：2025-12-29（周一）属 2026-W01（周四 2026-01-01 所在周）", () => {
    expect(isoWeekKey(2025, 12, 29)).toBe("2026-W01");
  });
});

describe("dateCmp（YYYY-MM-DD 字典序 = 时序）", () => {
  it("升序比较", () => {
    expect(dateCmp("2026-09-01", "2026-09-20")).toBe(-1);
    expect(dateCmp("2026-09-20", "2026-09-01")).toBe(1);
    expect(dateCmp("2026-09-20", "2026-09-20")).toBe(0);
  });
});

describe("buildMonthCells（月历格：周一起排 + 状态机）", () => {
  it("2026-09（30 天，1 号周二）：1 前置 null + 30 格 + 4 后置 null = 35", () => {
    const cells = buildMonthCells({
      monthStart: "2026-09-01",
      daysInMonth: 30,
      today: "2026-09-20",
      records: [],
    });
    expect(cells.length).toBe(35);
    expect(cells[0]).toBeNull();
    // 首格 = 9/1（周二，missing：早于今日且无记录）
    expect(cells[1]).toEqual({ date: "2026-09-01", state: "missing" });
    // 今日格 = pending（9/1 周二 → 9/20 = index 1+19）
    expect(cells[1 + 19]).toEqual({ date: "2026-09-20", state: "pending" });
    // 末日格 = 9/30（future）
    expect(cells[30]).toEqual({ date: "2026-09-30", state: "future" });
    // 尾格 null
    expect(cells[34]).toBeNull();
  });

  it("状态机：done / made / missing / pending / future", () => {
    const cells = buildMonthCells({
      monthStart: "2026-09-01",
      daysInMonth: 30,
      today: "2026-09-10",
      records: [
        { date: "2026-09-03", settled: true, madeUp: false },
        { date: "2026-09-05", settled: true, madeUp: true },
      ],
    });
    const byDate = new Map(cells.filter(Boolean).map((c) => [c!.date, c!.state]));
    expect(byDate.get("2026-09-03")).toBe("done");
    expect(byDate.get("2026-09-05")).toBe("made");
    expect(byDate.get("2026-09-01")).toBe("missing");
    expect(byDate.get("2026-09-10")).toBe("pending");
    expect(byDate.get("2026-09-11")).toBe("future");
  });

  it("2 月平年 28 天（review B2：真实天数格，非 28 格简化）", () => {
    const cells = buildMonthCells({
      monthStart: "2026-02-01",
      daysInMonth: 28,
      today: "2026-02-01",
      records: [],
    });
    const real = cells.filter(Boolean);
    expect(real.length).toBe(28);
    expect(real[real.length - 1]).toEqual({ date: "2026-02-28", state: "future" });
  });
});

/**
 * 周连满口径（详设 §2.1 / review B3）：结算补记发生在「周一首局结算」，
 * 补记的是「刚过去的那一周」。回扫窗口从本周周一往前，back=1 即上周
 * （周日严格早于今日 = 已完结）；本周（thisMonday 起）尚在进行中，不计。
 * 2026-09-21（周一）作基准结算日：back=1 → 9/14（W38 周一）… back=8 → 8/10（W33 周一）。
 */
describe("completedWeeks（周连满：已完结周 + 全 done|made）", () => {
  const TODAY = "2026-09-21"; // 周一结算日

  it("整 8 周全连满 → 8 个周键（含刚过去的上周 W38）", () => {
    const records: DailyRecord[] = [];
    // 9/14（W38 周一）起往前 8 周：W38..W31
    for (let back = 0; back < 8; back++) {
      const monday = new Date(Date.UTC(2026, 8, 14 - back * 7));
      const [y, m, d] = [monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()];
      records.push(...fullWeek(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`));
    }
    const keys = completedWeeks(records, TODAY);
    expect(keys.length).toBe(8);
    expect(keys).toContain("2026-W38"); // 刚过去的上周
    expect(keys).toContain("2026-W31"); // 窗口最远
  });

  it("缺一天 → 该周不计", () => {
    const full = fullWeek("2026-09-14"); // W38
    full.pop(); // 去掉周日（缺一天）
    expect(completedWeeks(full, TODAY).includes("2026-W38")).toBe(false);
  });

  it("未结算（settled=false）不算连满（过期未答）", () => {
    const settledFalse = fullWeek("2026-09-14").map((r) => ({ ...r, settled: false }));
    expect(completedWeeks(settledFalse, TODAY).includes("2026-W38")).toBe(false);
  });

  it("补签（madeUp=true + settled=true）计入连满（review A10）", () => {
    const week = fullWeek("2026-09-14"); // W38
    week[2] = { ...week[2], madeUp: true }; // 周三补签
    expect(completedWeeks(week, TODAY).includes("2026-W38")).toBe(true);
  });

  it("回扫窗口从本周周一对齐：本周（周日晚于今日）不计，上周计", () => {
    // today = 2026-09-14（周一）：thisMonday = 9/14
    // 本周 W38（9/14-9/20）周日 9/20 > 9/14 未完结 → 不计；
    // 上周 W37（9/7-9/13）周日 9/13 < 9/14 完结 → 计。
    const keys = completedWeeks([...fullWeek("2026-09-07"), ...fullWeek("2026-09-14")], "2026-09-14");
    expect(keys).toContain("2026-W37");
    expect(keys).not.toContain("2026-W38");
  });
});

describe("completedWeeksThisMonth（本月口径：跨月周按周四归属）", () => {
  const TODAY = "2026-09-21"; // 周一结算日

  it("本月内整周连满（W38：周四 9/17 在 9 月）→ 计 1", () => {
    expect(completedWeeksThisMonth(fullWeek("2026-09-14"), TODAY)).toBe(1);
  });

  it("跨月周 W37（9/7-9/13）周四 9/10 在 9 月 → 9 月口径计入", () => {
    expect(completedWeeksThisMonth(fullWeek("2026-09-07"), TODAY)).toBe(1);
  });

  it("窗口内但周四在 8 月的周（W33：8/10-8/16，周四 8/13）→ 9 月口径不计", () => {
    // W33 周一 8/10 = today(9/21) 回扫 back=6，在窗口内且连满，
    // 但 ISO 周键归 8 月（周四 8/13），本月口径过滤掉。
    expect(completedWeeksThisMonth(fullWeek("2026-08-10"), TODAY)).toBe(0);
  });

  it("两周全连满且都在 9 月 → 计 2", () => {
    const both = [...fullWeek("2026-09-14"), ...fullWeek("2026-09-07")];
    expect(completedWeeksThisMonth(both, TODAY)).toBe(2);
  });

  it("跨年边界：W01（12/29-1/4，周四 1/1 在 2026-01）→ 1 月口径计入", () => {
    expect(completedWeeksThisMonth(fullWeek("2025-12-29"), "2026-01-05")).toBe(1);
  });
});
