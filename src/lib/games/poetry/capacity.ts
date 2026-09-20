/**
 * 诗词升官 · 题库容量核算 · 纯逻辑层（零依赖）
 *
 * 职责：
 * - 统计每个 grade 档的理论题面上限（未过滤有效干扰项）。
 *   去重粒度 = 题面 key（faceKey，题干 + 正确答案 + 题型）；实际可出题池须调用 rankedRoundPool
 *   （见 engine.buildRankedRounds / engine.faceKey），不是「同诗永不出现」。
 * - 提供「完整晋升路径」的消耗模型：按给定计分场景（全对 / 80% / 60%）、
 *   含科考与失败重试，估算到达各官阶需消耗多少道「全新不重复题」，
 *   并逐阶判断窗口是否被耗尽（blocked）。
 *
 * 红线：本模块只读语料、不写任何库；估算的全部假设在报告中显式列出，
 * 不伪造真实用户模拟结论。
 */

import {
  PoemCorpusItem,
  PoetryQuestionType,
} from "./types";
import { faceKey } from "./engine";
import { fillCharPositions } from "./distractors";
import type { RankSpec } from "./rank";

const ALL_TYPES: PoetryQuestionType[] = [
  PoetryQuestionType.GUESS_POET,
  PoetryQuestionType.GUESS_TITLE,
  PoetryQuestionType.COMPLETE_NEXT,
  // D3 新题型（详设 §3.2 / review A2）：容量审计须计入，否则审计漏算导致
  // 「以为够实际不够」
  PoetryQuestionType.FILL_CHAR,
  PoetryQuestionType.DYNASTY_PICK,
];

/**
 * 每个 grade 档内「互不重复的题面」数量。
 * 同一首合法句位 × 题型各贡献一道；faceKey 相同（同题干同答案同题型）只算一道。
 * FILL_CHAR 按挖字位 pos 枚举（每 CJK 字位一道，review A2）；单字句跳过。
 * 注意：faceKey 不含 grade，理论上两首不同 grade 的诗若逐字相同会被分入不同档各记一次，
 * 审计报告以「全库题面并集」为准修正该极小边界（见 totalDistinctFaces）。
 */
export function distinctFacesByGrade(corpus: PoemCorpusItem[]): Map<number, number> {
  const perGrade = new Map<number, Set<string>>();
  for (const item of corpus) {
    for (let i = 0; i < item.lines.length - 1; i++) {
      for (const type of ALL_TYPES) {
        if (!perGrade.has(item.grade)) perGrade.set(item.grade, new Set());
        const s = perGrade.get(item.grade)!;
        if (type === PoetryQuestionType.FILL_CHAR) {
          const positions = fillCharPositions(item.lines[i]);
          if (positions.length === 0) continue;
          for (const pos of positions) s.add(faceKey(item, i, type, pos));
          continue;
        }
        s.add(faceKey(item, i, type));
      }
    }
  }
  return new Map([...perGrade.entries()].map(([g, s]) => [g, s.size]));
}

/** 全库互不重复的题面总数（并集，跨 grade 去重，容量硬上限） */
export function totalDistinctFaces(corpus: PoemCorpusItem[]): number {
  const all = new Set<string>();
  for (const item of corpus) {
    for (let i = 0; i < item.lines.length - 1; i++) {
      for (const type of ALL_TYPES) {
        if (type === PoetryQuestionType.FILL_CHAR) {
          const positions = fillCharPositions(item.lines[i]);
          if (positions.length === 0) continue;
          for (const pos of positions) all.add(faceKey(item, i, type, pos));
          continue;
        }
        all.add(faceKey(item, i, type));
      }
    }
  }
  return all.size;
}

/** 闭区间内的整数 grade 列表（升序） */
function gradeList(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let g = lo; g <= hi; g++) out.push(g);
  return out;
}

/** 某官阶该 kind 的 grade 窗口（科考用 examWindow，研习/每日用本官阶主窗口 gradeWindow） */
export function rankGradeWindow(rank: RankSpec, kind: "PRACTICE" | "EXAM" | "DAILY"): [number, number] {
  return kind === "EXAM" ? rank.examWindow : rank.gradeWindow;
}

export interface PathSimulationInput {
  /** 每个 grade 档的互不重复题面数（distinctFacesByGrade 的输出） */
  facesByGrade: Map<number, number>;
  /** 官阶表（rank.ts 的 RANKS，普通 0..9，不含皇帝 Boss） */
  ranks: RankSpec[];
  /** 一局（10 题）研习授予的功名（由计分场景计算，见报告假设） */
  expPerPractice: number;
  /** 一局「通过的」科考授予的功名（失败局保守记 0） */
  expPerExam: number;
  /** 通过前最多失败重试次数（0 = 一次过；失败局同样消耗 10 道新题） */
  maxExamRetries: number;
  /** 起始官阶，默认 0（布衣） */
  startRank?: number;
  /** 目标官阶 id（到达即止），默认最后一阶（丞相） */
  stopAtRank?: number;
  /**
   * 全库互不重复题面总数（硬上限）。缺省时按各 grade 档之和估计
   * （跨 grade 同题面会被重复计数，故缺省值偏大；审计应传 totalDistinctFaces 的真实值）。
   */
  globalDistinct?: number;
}

export interface RankConsumption {
  rank: number;
  key: string;
  label: string;
  /** 晋升本阶所需研习局数 */
  practiceGames: number;
  /** 科考尝试次数（含失败重试，1 次通过 + maxExamRetries 次失败） */
  examAttempts: number;
  /** 本阶消耗的「全新不重复题」总数 */
  questionsConsumed: number;
  /** 消耗前，本阶窗口（研习窗 ∪ 科考窗）内剩余可用新题 */
  availableFresh: number;
  /** 缺口：>0 表示本阶窗口被耗尽，晋升受阻 */
  shortfall: number;
}

export interface PathSimulationResult {
  perRank: RankConsumption[];
  /** 完成路径所需新题总数，含尚未满足的缺口；并非实际已出题数。 */
  totalQuestions: number;
  /** 全库互不重复题面总数（硬上限） */
  globalDistinct: number;
  /** 全局缺口：>0 表示即便窗口不重叠，全库也不够（硬阻塞） */
  globalShortfall: number;
  /** 首个被耗尽的官阶 id；null 表示全路径可行 */
  firstBlockedRank: number | null;
  /** 全路径是否可行（无窗口耗尽且全局不超上限） */
  feasible: boolean;
}

/**
 * 模拟「从 startRank 一路考到 stopAtRank」的题库消耗。
 *
 * 模型（假设在报告列出）：
 * 1. 玩家由官阶 r 升到 r+1：先在 r 的**研习窗口**刷题把功名攒到下一阶门槛，
 *    再到 r+1 的**科考窗口**通过一场科考（目标 r+1）。
 * 2. 研习 / 科考都授予功名（见 expPerPractice / expPerExam）。
 * 3. 失败 / 弃局同样消耗新题：科考按「maxExamRetries 次失败 + 1 次通过」计，
 *    每次尝试消耗 10 道全新题（出题即标记已见）。
 * 4. 不重复是全局的：任一处消耗的题，对后续所有官阶都消失（跨窗去重）。
 * 5. 消耗按「研习从 gradeWindow 低档起、科考从 examWindow 低档起」扣减，
 *    这是聚合容量估算，不是随机出题器的真实回放；缺题后继续计算的是未满足需求。
 */
export function simulatePath(input: PathSimulationInput): PathSimulationResult {
  const { facesByGrade, ranks, expPerPractice, expPerExam, maxExamRetries } = input;
  const startRank = input.startRank ?? 0;
  const stopAtRank = input.stopAtRank ?? ranks.length - 1;

  const consumed = new Map<number, number>();
  const fresh = (g: number) => Math.max(0, (facesByGrade.get(g) ?? 0) - (consumed.get(g) ?? 0));

  /** 从某窗口的若干 grade 扣减 amount，返回实际扣到的量（不足则扣到见底） */
  const consumeFrom = (grades: number[], amount: number): number => {
    let left = amount;
    for (const g of grades) {
      if (left <= 0) break;
      const avail = fresh(g);
      const take = Math.min(avail, left);
      consumed.set(g, (consumed.get(g) ?? 0) + take);
      left -= take;
    }
    return amount - left;
  };

  let currentExp = 0;
  const perRank: RankConsumption[] = [];
  let firstBlockedRank: number | null = null;
  let totalQuestions = 0;

  for (let r = startRank; r < stopAtRank; r++) {
    const rank = ranks[r];
    const next = ranks[r + 1];
    const targetExp = next.expToReach;

    // 研习局数：把功名从 currentExp 攒到 targetExp（每局 expPerPractice）
    const practiceGames =
      currentExp >= targetExp ? 0 : Math.ceil((targetExp - currentExp) / Math.max(1, expPerPractice));
    currentExp += practiceGames * expPerPractice;

    const examAttempts = 1 + Math.max(0, maxExamRetries);
    const practiceQuestions = practiceGames * 10;
    const examQuestions = examAttempts * (next.isEmperor ? 15 : 10);

    const practiceGrades = gradeList(rank.gradeWindow[0], rank.gradeWindow[1]);
    const examGrades = gradeList(next.examWindow[0], next.examWindow[1]);
    const unionGrades = [...new Set([...practiceGrades, ...examGrades])];
    const availableFresh = unionGrades.reduce((s, g) => s + fresh(g), 0);

    // 先扣研习窗，再扣科考窗（不足即缺口）
    const practiceTaken = consumeFrom(practiceGrades, practiceQuestions);
    const examTaken = consumeFrom(examGrades, examQuestions);
    const shortfall = (practiceQuestions - practiceTaken) + (examQuestions - examTaken);

    if (shortfall > 0 && firstBlockedRank === null) firstBlockedRank = r;

    const questionsConsumed = practiceTaken + examTaken;
    totalQuestions += practiceQuestions + examQuestions;
    currentExp += expPerExam; // 通过科考再授予功名（失败局保守记 0）

    perRank.push({
      rank: r,
      key: rank.key,
      label: rank.label,
      practiceGames,
      examAttempts,
      questionsConsumed,
      availableFresh,
      shortfall,
    });
  }

  const globalDistinct =
    input.globalDistinct ?? [...input.facesByGrade.values()].reduce((s, v) => s + v, 0);
  const globalShortfall = Math.max(0, totalQuestions - globalDistinct);

  return {
    perRank,
    totalQuestions,
    globalDistinct,
    globalShortfall,
    firstBlockedRank,
    feasible: firstBlockedRank === null && globalShortfall === 0,
  };
}
