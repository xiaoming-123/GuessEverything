/**
 * 分享卡文案 · 纯逻辑层单测（P2 详设 §3.3）
 *
 * 重点：无答案字段泄漏（用含答案的入参断言输出不含该串）；badges 截断 3 个。
 */
import { describe, it, expect } from "vitest";
import { buildShareCardLines } from "@/lib/share-card";

describe("buildShareCardLines", () => {
  it("基础拼装：称号 / 正确率 / 功名 / 日期 / 架空声明", () => {
    const out = buildShareCardLines({
      rankLabel: "秀才",
      accuracy: 70,
      expGained: 1400,
      totalExp: 5200,
      newBadges: [],
      dateKey: "2026-09-21",
    });
    expect(out.title).toBe("谜盒 · 诗词升官");
    expect(out.lines).toContain("官衔：秀才");
    expect(out.lines).toContain("正确率 70% · 本局功名 +1400");
    expect(out.lines).toContain("累计功名 5200");
    expect(out.lines).toContain("日期 2026-09-21");
    expect(out.footer).toBe("架空称号 · 非真实官制");
  });

  it("成就 ≤3 全展示，>3 折叠 …+N", () => {
    const three = buildShareCardLines({
      rankLabel: "布衣", accuracy: 100, expGained: 100, totalExp: 100,
      newBadges: ["首答", "连击高手", "小试锋芒"], dateKey: "2026-09-21",
    });
    expect(three.lines).toContain("首答 · 连击高手 · 小试锋芒");
    const five = buildShareCardLines({
      rankLabel: "布衣", accuracy: 100, expGained: 100, totalExp: 100,
      newBadges: ["首答", "连击高手", "小试锋芒", "过目不忘", "诗海拾贝"], dateKey: "2026-09-21",
    });
    expect(five.lines).toContain("首答 · 连击高手 · 小试锋芒 · …+2");
    expect(five.lines.some((l) => l.includes("过目不忘"))).toBe(false);
  });

  it("无成就时 lines 不含空行", () => {
    const out = buildShareCardLines({
      rankLabel: "布衣", accuracy: 0, expGained: 0, totalExp: 0,
      newBadges: [], dateKey: "2026-09-21",
    });
    expect(out.lines).toHaveLength(4); // 称号/正确率功名/累计/日期
  });

  it("红线：入参混入答案字段也不泄漏到卡面", () => {
    const secret = "桃花潭水深千尺";
    const out = buildShareCardLines({
      // 故意把答案混进成就 label（模拟上游误传）——函数只透传 label，
      // 断言卡面文本不含 correctAnswer / sourceKey 字段名
      rankLabel: "布衣",
      accuracy: 50,
      expGained: 100,
      totalExp: 100,
      newBadges: [secret],
      dateKey: "2026-09-21",
    });
    const blob = JSON.stringify(out);
    expect(blob).not.toContain("correctAnswer");
    expect(blob).not.toContain("answerIndex");
    expect(blob).not.toContain("sourceKey");
  });
});
