import { describe, expect, it } from "vitest";
import {
  distinctFacesByGrade,
  simulatePath,
  totalDistinctFaces,
} from "@/lib/games/poetry/capacity";
import { RANKS } from "@/lib/games/poetry/rank";
import type { PoemCorpusItem } from "@/lib/games/poetry/types";

const fourLines = (prefix: string) => [0, 1, 2, 3].map((i) => `${prefix}句${i}`);

/** 4 句诗（不同 id 间诗句互不相同，避免跨题面碰撞） */
const poem = (id: string, grade: number, prefix: string, poet = "李白"): PoemCorpusItem => ({
  id,
  title: `诗${id}`,
  poet,
  dynasty: "唐",
  grade,
  lines: fourLines(prefix),
  famous: false,
});

describe("distinctFacesByGrade / totalDistinctFaces", () => {
  it("每首诗贡献「句位数 × 3 题型」个题面，按 grade 归档", () => {
    const corpus = [poem("x", 1, "a"), poem("y", 12, "b")];
    const byGrade = distinctFacesByGrade(corpus);
    expect(byGrade.get(1)).toBe(9); // 4 句 → 3 句位 × 3 题型
    expect(byGrade.get(12)).toBe(9);
    expect(totalDistinctFaces(corpus)).toBe(18);
  });

  it("同题面（逐字相同、不同 id/grade）：全库并集 < 各档之和", () => {
    // 两首**完全相同**（同 title / 同 poet / 同 lines），仅 id 与 grade 不同
    const sameLines = fourLines("z");
    const corpus: PoemCorpusItem[] = [
      { id: "p1", title: "登高", poet: "杜甫", dynasty: "唐", grade: 1, lines: sameLines, famous: false },
      { id: "p2", title: "登高", poet: "杜甫", dynasty: "唐", grade: 2, lines: sameLines, famous: false },
    ];
    const byGrade = distinctFacesByGrade(corpus);
    expect(byGrade.get(1)).toBe(9);
    expect(byGrade.get(2)).toBe(9);
    // faceKey 不含 grade/ id，两首同题面 → 并集只算 9
    expect(totalDistinctFaces(corpus)).toBe(9);
    expect(totalDistinctFaces(corpus)).toBeLessThan((byGrade.get(1) ?? 0) + (byGrade.get(2) ?? 0));
  });

  it("同一首诗不同句位 / 题型算不同题面（不把严格去重暗改为同诗永不出现）", () => {
    const corpus = [poem("a", 1, "k")];
    // 单首 4 句 → 9 个不同题面（3 句位 × 3 题型）
    expect(totalDistinctFaces(corpus)).toBe(9);
  });
});

describe("simulatePath", () => {
  it("缺题时仍报告完整需求，不能以实际抽到的数量低估全局缺口", () => {
    const sim = simulatePath({ facesByGrade: new Map(), ranks: RANKS.slice(0, 10),
      expPerPractice: 2000, expPerExam: 2000, maxExamRetries: 0, globalDistinct: 0 });
    expect(sim.totalQuestions).toBe(790);
    expect(sim.globalShortfall).toBe(790);
    expect(sim.perRank.every((r) => r.questionsConsumed === 0)).toBe(true);
  });

  it("晋升考试用目标官阶窗口，皇帝大考消耗十五题", () => {
    const sim = simulatePath({ facesByGrade: new Map([[12, 100]]), ranks: RANKS,
      startRank: 9, stopAtRank: 10, expPerPractice: 2000, expPerExam: 2000, maxExamRetries: 0 });
    expect(sim.totalQuestions).toBe(15);
  });
  const normalRanks = RANKS.slice(0, 10);
  // 充足语料：每 grade 30 首（诗句互不相同）→ 3240 个题面，远超全路径消耗上界
  const bigCorpus: PoemCorpusItem[] = [];
  for (let g = 1; g <= 12; g++) {
    for (let i = 0; i < 30; i++) {
      bigCorpus.push({
        id: `g${g}-${i}`,
        title: `诗${g}${i}`,
        poet: `诗人${i}`,
        dynasty: "唐",
        grade: g,
        lines: fourLines(`L${g}-${i}`),
        famous: false,
      });
    }
  }

  it("语料充足时全路径可行（feasible=true，无缺口）", () => {
    const byGrade = distinctFacesByGrade(bigCorpus);
    const sim = simulatePath({
      facesByGrade: byGrade,
      ranks: normalRanks,
      expPerPractice: 2000,
      expPerExam: 2000,
      maxExamRetries: 0,
      globalDistinct: totalDistinctFaces(bigCorpus),
    });
    expect(sim.firstBlockedRank).toBeNull();
    expect(sim.feasible).toBe(true);
    expect(sim.globalShortfall).toBe(0);
    expect(sim.perRank).toHaveLength(9); // 布衣→丞相共 9 次晋升
  });

  it("语料不足时标记首个耗尽官阶且 feasible=false（窗口瓶颈）", () => {
    const lowOnly = bigCorpus.filter((p) => p.grade <= 3);
    const byGrade = distinctFacesByGrade(lowOnly);
    const sim = simulatePath({
      facesByGrade: byGrade,
      ranks: normalRanks,
      expPerPractice: 1120,
      expPerExam: 1120,
      maxExamRetries: 0,
      globalDistinct: totalDistinctFaces(lowOnly),
    });
    expect(sim.feasible).toBe(false);
    expect(sim.firstBlockedRank).not.toBeNull();
  });

  it("功名越高 → 消耗新题越少（研习局数随 expPerPractice 上升而下降）", () => {
    const byGrade = distinctFacesByGrade(bigCorpus);
    const base = simulatePath({
      facesByGrade: byGrade,
      ranks: normalRanks,
      expPerPractice: 1120,
      expPerExam: 1120,
      maxExamRetries: 0,
      globalDistinct: totalDistinctFaces(bigCorpus),
    });
    const fast = simulatePath({
      facesByGrade: byGrade,
      ranks: normalRanks,
      expPerPractice: 2000,
      expPerExam: 2000,
      maxExamRetries: 0,
      globalDistinct: totalDistinctFaces(bigCorpus),
    });
    expect(fast.totalQuestions).toBeLessThan(base.totalQuestions);
  });

  it("失败重试会额外消耗新题（maxExamRetries 越大 totalQuestions 越大）", () => {
    const byGrade = distinctFacesByGrade(bigCorpus);
    const noRetry = simulatePath({
      facesByGrade: byGrade,
      ranks: normalRanks,
      expPerPractice: 1560,
      expPerExam: 1560,
      maxExamRetries: 0,
      globalDistinct: totalDistinctFaces(bigCorpus),
    });
    const retry = simulatePath({
      facesByGrade: byGrade,
      ranks: normalRanks,
      expPerPractice: 1560,
      expPerExam: 1560,
      maxExamRetries: 1,
      globalDistinct: totalDistinctFaces(bigCorpus),
    });
    expect(retry.totalQuestions).toBeGreaterThan(noRetry.totalQuestions);
  });
});
