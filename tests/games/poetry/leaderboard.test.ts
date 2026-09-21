/**
 * D6 · 皇榜纯逻辑层单测（详设 §4.5 / §7 D6；P3-2 改赛季功名口径）
 *
 * 验收项：
 * - mergeLeaderboard：seasonExp / rank / name 三键稳定排序、虚拟位混排、limit 截断、
 *   空 real 返回全虚拟
 * - myChaseTarget（review B6）：虚拟位压顶时追赶目标 = 虚拟位、同赛季功名边界、
 *   我是榜首返回 null
 */
import { describe, expect, it } from "vitest";
import {
  myChaseTarget,
  mergeLeaderboard,
  VIRTUAL_ENTRIES,
} from "@/lib/games/poetry/leaderboard";
import { RANKS } from "@/lib/games/poetry/rank";

/** 构造真实玩家条目（rank 用官阶 id；seasonExp = 皇榜主排序键，totalExp 仅透传） */
const real = (
  name: string,
  rank: number,
  seasonExp: number,
  totalExp = seasonExp,
  avatar = "🙂",
) => ({ name, avatar, rank, totalExp, seasonExp });

describe("mergeLeaderboard 合并排序（P3-2：seasonExp → rank → name）", () => {
  it("空 real 返回全虚拟位（5 个，赛季功名序：苏轼 32000 → 辛弃疾 24000 → 李白 18000 → 王勃 8000 → 孟浩然 4500）", () => {
    const got = mergeLeaderboard([]);
    expect(got).toHaveLength(5);
    expect(got.every((e) => e.isVirtual)).toBe(true);
    expect(got.map((e) => e.name)).toEqual(["苏轼", "辛弃疾", "李白", "王勃", "孟浩然"]);
    // rankLabel 与 RANKS 一致
    expect(got[0].rankLabel).toBe(RANKS[8].label);
    // seasonExp 透传
    expect(got[0].seasonExp).toBe(32000);
  });

  it("赛季功名为第一排序键：低官阶高赛季功名压过高官阶低赛季功名", () => {
    const got = mergeLeaderboard([
      real("新贵", 2, 40000), // 秀才，但本季 40000 > 苏轼 32000
      real("老将", 9, 100, 300000), // 丞相，本季只 100 → 垫底（totalExp 不参与排序）
    ]);
    expect(got[0].name).toBe("新贵");
    expect(got[1].name).toBe("苏轼");
    expect(got[got.length - 1].name).toBe("老将");
  });

  it("同赛季功名按官阶降序（rank 第二键）", () => {
    const got = mergeLeaderboard([
      real("低阶", 2, 20000),
      real("高阶", 9, 20000),
      real("中阶", 5, 20000),
    ]);
    expect(got.filter((e) => !e.isVirtual).map((e) => e.name)).toEqual(["高阶", "中阶", "低阶"]);
  });

  it("limit 截断（默认 100，可指定）", () => {
    // 全部压在虚拟位之上（50000+ > 苏轼 32000），确保截断段全为真实位
    const many = Array.from({ length: 10 }, (_, i) => real(`生${i}`, 9, 50000 + 100 * i));
    const got = mergeLeaderboard(many, 5);
    expect(got).toHaveLength(5);
    expect(got[0].name).toBe("生9");
    expect(got[4].name).toBe("生5");
  });

  it("同赛季功名同官阶不抖动：name 码点升序稳定（丙 U+4E19 < 乙 U+4E59 < 甲 U+7532）", () => {
    const mk = () => [real("丙", 0, 500), real("甲", 0, 500), real("乙", 0, 500)];
    const names = mergeLeaderboard(mk(), 10)
      .filter((e) => e.seasonExp === 500)
      .map((e) => e.name);
    expect(names).toEqual(["丙", "乙", "甲"]);
    // 多次调用结果一致（稳定排序）
    const again = mergeLeaderboard(mk(), 10)
      .filter((e) => e.seasonExp === 500)
      .map((e) => e.name);
    expect(again).toEqual(["丙", "乙", "甲"]);
  });
});

describe("myChaseTarget 我的追赶卡（赛季功名口径）", () => {
  it("虚拟位压顶：我前面最近一位 = 虚拟位（aboveName/aboveLabel 正确）", () => {
    // 我：秀才(rank 2) 本季 4400；虚拟孟浩然秀才 4500 压在我头上
    const merged = mergeLeaderboard([], Infinity);
    const t = myChaseTarget({ name: "我", rank: 2, seasonExp: 4400 }, merged);
    expect(t).not.toBeNull();
    // 我前面 = 苏轼/辛弃疾/李白/王勃/孟浩然 共 5 位（seasonExp 全部 > 4400）
    expect(t!.aboveCount).toBe(5);
    expect(t!.aboveName).toBe("孟浩然");
    expect(t!.aboveLabel).toBe("秀才");
    expect(t!.aboveExp).toBe(4500);
  });

  it("我是榜首：无人排在我前 → null", () => {
    const merged = mergeLeaderboard([real("我", 8, 999999)], Infinity);
    expect(myChaseTarget({ name: "我", rank: 8, seasonExp: 999999 }, merged)).toBeNull();
  });

  it("我夹在虚拟位之间：aboveCount 精确", () => {
    // 我：翰林(rank 6) 本季 17000；李白 18000 在我前，王勃 8000 在我后
    const merged = mergeLeaderboard([], Infinity);
    const t = myChaseTarget({ name: "我", rank: 6, seasonExp: 17000 }, merged);
    expect(t).not.toBeNull();
    expect(t!.aboveCount).toBe(3);
    expect(t!.aboveName).toBe("李白");
    expect(t!.aboveLabel).toBe("翰林");
    expect(t!.aboveExp).toBe(18000);
  });

  it("同赛季功名同官阶边界：name 码点后于虚拟位（「王超」>「王勃」），虚拟位仍是最近目标", () => {
    // 我：举人(rank 3) 本季 8000，与虚拟王勃同阶同赛季功名。
    // 「王超」(超 U+8D85) 码点大于「王勃」(勃 U+52C3) → 王勃排我前、我排其后。
    const merged = mergeLeaderboard([], Infinity);
    const t = myChaseTarget({ name: "王超", rank: 3, seasonExp: 8000 }, merged);
    expect(t).not.toBeNull();
    expect(t!.aboveCount).toBe(4);
    expect(t!.aboveName).toBe("王勃");
    expect(t!.aboveLabel).toBe("举人");
    expect(t!.aboveExp).toBe(8000);
  });

  it("真实玩家比我高：追赶目标 = 真实玩家", () => {
    const merged = mergeLeaderboard([real("师兄", 4, 9000), real("同窗", 3, 8500)], Infinity);
    // 我：举人(rank 3) 本季 8000。在我前的 5 位：苏轼 32000 / 辛弃疾 24000 / 李白 18000 /
    // 师兄 9000 / 同窗 8500；王勃同分同阶但「我」(U+6211) 码点先于「王勃」(U+738B) → 王勃在我后。
    const t = myChaseTarget({ name: "我", rank: 3, seasonExp: 8000 }, merged);
    expect(t).not.toBeNull();
    expect(t!.aboveCount).toBe(5);
    expect(t!.aboveName).toBe("同窗");
    expect(t!.aboveLabel).toBe("举人");
    expect(t!.aboveExp).toBe(8500);
  });

  it("me 不在 merged 时退化为比较法（real 未含我）", () => {
    const merged = mergeLeaderboard([], Infinity);
    // 我：童生(rank 1) 本季 3000 → 5 个虚拟位（最低 4500）全在我前，最近 = 孟浩然
    const t = myChaseTarget({ name: "我", rank: 1, seasonExp: 3000 }, merged);
    expect(t).not.toBeNull();
    expect(t!.aboveCount).toBe(5);
    expect(t!.aboveName).toBe("孟浩然");
  });
});

describe("VIRTUAL_ENTRIES 常量完整性", () => {
  it("5 个虚拟位，rankLabel 均为真实 RANKS 称号（架空但不虚构），功名与赛季功名均为正", () => {
    expect(VIRTUAL_ENTRIES).toHaveLength(5);
    for (const v of VIRTUAL_ENTRIES) {
      expect(RANKS.some((r) => r.label === v.rankLabel)).toBe(true);
      expect(v.totalExp).toBeGreaterThan(0);
      expect(v.seasonExp).toBeGreaterThan(0);
      expect(v.isVirtual).toBe(true);
    }
  });
});
