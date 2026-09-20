/**
 * D6 · 皇榜纯逻辑层单测（详设 §4.5 / §7 D6）
 *
 * 验收项：
 * - mergeLeaderboard：官阶/功名/name 三键稳定排序、虚拟位混排、limit 截断、
 *   空 real 返回全虚拟
 * - myChaseTarget（review B6）：虚拟位压顶时追赶目标 = 虚拟位、同阶同功名边界、
 *   我是榜首返回 null
 */
import { describe, expect, it } from "vitest";
import {
  myChaseTarget,
  mergeLeaderboard,
  VIRTUAL_ENTRIES,
  type LeaderboardEntry,
} from "@/lib/games/poetry/leaderboard";
import { RANKS } from "@/lib/games/poetry/rank";

/** 构造真实玩家条目（rank 用官阶 id） */
const real = (
  name: string,
  rank: number,
  totalExp: number,
  avatar = "🙂",
) => ({ name, avatar, rank, totalExp });

describe("mergeLeaderboard 合并排序", () => {
  it("空 real 返回全虚拟位（5 个，官阶序：苏轼侍郎 → 辛弃疾知府 → 李白翰林 → 王勃举人 → 孟浩然秀才）", () => {
    const got = mergeLeaderboard([]);
    expect(got).toHaveLength(5);
    expect(got.every((e) => e.isVirtual)).toBe(true);
    expect(got[0].name).toBe("苏轼"); // 侍郎 rank 8
    expect(got[1].name).toBe("辛弃疾"); // 知府 rank 7
    expect(got[2].name).toBe("李白"); // 翰林 rank 6
    expect(got[3].name).toBe("王勃"); // 举人 rank 3
    expect(got[4].name).toBe("孟浩然"); // 秀才 rank 2
    // rankLabel 与 RANKS 一致
    expect(got[0].rankLabel).toBe(RANKS[8].label);
  });

  it("虚拟位与真实位混排：真实侍郎(120000) 压过虚拟苏轼(112000)", () => {
    const got = mergeLeaderboard([
      real("甲", 8, 120000), // 侍郎 120000
      real("乙", 8, 90000), // 侍郎 90000
    ]);
    expect(got[0].name).toBe("甲");
    expect(got[1].name).toBe("苏轼");
    expect(got[2].name).toBe("乙");
    expect(got[3].name).toBe("辛弃疾");
  });

  it("同官阶按功名降序（用丞相 rank 9 避免与虚拟位高官阶混排）", () => {
    const got = mergeLeaderboard([
      real("低功名", 9, 1000),
      real("高功名", 9, 9000),
      real("中功名", 9, 4000),
    ]);
    // 丞相 rank 9 高于所有虚拟位；高功名 9000 > 中功名 4000 > 低功名 1000
    expect(got[0].name).toBe("高功名");
    expect(got[1].name).toBe("中功名");
    expect(got[2].name).toBe("低功名");
  });

  it("limit 截断（默认 100，可指定）", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      real(`生${i}`, 9, 100 * i),
    );
    const got = mergeLeaderboard(many, 5);
    expect(got).toHaveLength(5);
    // 官阶 9（丞相），功名降序 → 生9(900) 在前
    expect(got[0].name).toBe("生9");
    expect(got[4].name).toBe("生5");
  });

  it("同官阶同功名不抖动：name 码点升序稳定（丙 U+4E19 < 乙 U+4E59 < 甲 U+7532）", () => {
    const a = mergeLeaderboard([real("丙", 0, 500), real("甲", 0, 500), real("乙", 0, 500)], 10);
    const names = a.filter((e) => e.totalExp === 500).map((e) => e.name);
    expect(names).toEqual(["丙", "乙", "甲"]);
    // 多次调用结果一致（稳定排序）
    const b = mergeLeaderboard([real("丙", 0, 500), real("甲", 0, 500), real("乙", 0, 500)], 10);
    expect(b.filter((e) => e.totalExp === 500).map((e) => e.name)).toEqual(["丙", "乙", "甲"]);
  });
});

describe("myChaseTarget 我的追赶卡", () => {
  it("虚拟位压顶：我前面最近一位 = 虚拟位（aboveName/aboveLabel 正确）", () => {
    // 我：秀才(rank 2) 5900；虚拟孟浩然秀才 6000 压在我头上
    const merged = mergeLeaderboard([], Infinity);
    const t = myChaseTarget({ name: "我", rank: 2, totalExp: 5900 }, merged);
    expect(t).not.toBeNull();
    // 我前面 = 苏轼(8)/辛弃疾(7)/李白(6)/王勃(3)/孟浩然(2,6000) 共 5 位
    expect(t!.aboveCount).toBe(5);
    // 最近一位 = 孟浩然（秀才 6000）
    expect(t!.aboveName).toBe("孟浩然");
    expect(t!.aboveLabel).toBe("秀才");
    expect(t!.aboveExp).toBe(6000);
  });

  it("我是榜首：无人排在我前 → null", () => {
    const merged = mergeLeaderboard([real("我", 8, 999999)], Infinity);
    const t = myChaseTarget({ name: "我", rank: 8, totalExp: 999999 }, merged);
    expect(t).toBeNull();
  });

  it("我夹在虚拟位之间：aboveCount 精确", () => {
    // 我：翰林(rank 6) 50000；虚拟李白翰林 52000 在我前；
    // 虚拟苏轼/辛弃疾 官阶更高在我前；虚拟王勃举人/孟浩然秀才 官阶更低在我后。
    const merged = mergeLeaderboard([], Infinity);
    const t = myChaseTarget({ name: "我", rank: 6, totalExp: 50000 }, merged);
    // 前面 = 苏轼(8)、辛弃疾(7)、李白(6,52000) 共 3 位
    expect(t).not.toBeNull();
    expect(t!.aboveCount).toBe(3);
    expect(t!.aboveName).toBe("李白");
    expect(t!.aboveLabel).toBe("翰林");
    expect(t!.aboveExp).toBe(52000);
  });

  it("同阶同功名边界：name 码点后于虚拟位（「王超」>「王勃」），虚拟位仍是最近目标", () => {
    // 我：举人(rank 3) 12000，与虚拟王勃同阶同功名。
    // 「王超」(超 U+8D85) 码点大于「王勃」(勃 U+5353) → 王勃排我前、我排其后。
    const merged = mergeLeaderboard([], Infinity);
    const t = myChaseTarget({ name: "王超", rank: 3, totalExp: 12000 }, merged);
    // 前面 = 苏轼/辛弃疾/李白/王勃(同阶同功名,name 在前) 共 4 位
    expect(t).not.toBeNull();
    expect(t!.aboveCount).toBe(4);
    expect(t!.aboveName).toBe("王勃");
    expect(t!.aboveLabel).toBe("举人");
    expect(t!.aboveExp).toBe(12000);
  });

  it("真实玩家比我高：追赶目标 = 真实玩家", () => {
    const merged = mergeLeaderboard(
      [real("师兄", 4, 20000), real("同窗", 3, 11000)],
      Infinity,
    );
    // 我：举人(rank 3) 9000；前面 = 苏轼/辛弃疾/李白/师兄(贡士)/王勃(举人12000 但 12000>9000 在我前)/同窗(举人11000 在我前)
    const t = myChaseTarget({ name: "我", rank: 3, totalExp: 9000 }, merged);
    expect(t).not.toBeNull();
    // 最近一位（排得最靠后但仍在我前）= 同窗（举人 11000）
    expect(t!.aboveName).toBe("同窗");
    expect(t!.aboveLabel).toBe("举人");
    expect(t!.aboveExp).toBe(11000);
  });

  it("me 不在 merged 时退化为比较法（real 未含我）", () => {
    // merged 只有虚拟位（real 为空），我作为「外部玩家」比较
    const merged = mergeLeaderboard([], Infinity);
    // 我：童生(rank 1) 3000 → 前面只有 苏轼/辛弃疾/李白/王勃/孟浩然(6000) 中官阶≥我且功名>我的
    // 孟浩然秀才 6000 > 我童生 3000 且官阶(2)>我(1) → 在我前；
    // 前面共 5 位（苏轼/辛弃疾/李白/王勃/孟浩然），最近 = 孟浩然
    const t = myChaseTarget({ name: "我", rank: 1, totalExp: 3000 }, merged);
    expect(t).not.toBeNull();
    expect(t!.aboveCount).toBe(5);
    expect(t!.aboveName).toBe("孟浩然");
  });
});

describe("VIRTUAL_ENTRIES 常量完整性", () => {
  it("5 个虚拟位，rankLabel 均为真实 RANKS 称号（架空但不虚构）", () => {
    expect(VIRTUAL_ENTRIES).toHaveLength(5);
    for (const v of VIRTUAL_ENTRIES) {
      expect(RANKS.some((r) => r.label === v.rankLabel)).toBe(true);
      expect(v.totalExp).toBeGreaterThan(0);
      expect(v.isVirtual).toBe(true);
    }
  });
});
