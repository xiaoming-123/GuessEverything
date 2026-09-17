/**
 * 飞花令出题引擎 · 纯函数
 *
 * 输入诗词语料 + 参数，输出完整轮次（含答案）。
 * 答案剥离（toRoundView）在服务端 API 层执行，引擎不负责。
 *
 * 三题型：
 * - FIND_CONTAINS 寻句：令字已知，选含字诗句（目标句含字 / 干扰句不含）
 * - FIND_MISSING  挑白：令字已知，选不含字诗句（目标句不含 / 干扰句含字）
 * - GUESS_CHAR    猜令：诗句已知，选句中令字（目标字在句中 / 干扰字不在）
 */

import { weightedOrder } from "@/lib/games/sampling";
import type { PoemCorpusItem } from "@/lib/games/poetry/types";
import { buildLingIndex, buildSentences } from "./corpus";
import {
  mulberry32,
  pickDistractors,
  sample,
  withCharPool,
  withoutCharPool,
} from "./distractors";
import {
  BuildRoundsOptions,
  DIFFICULTY_RANGE,
  DIFFICULTY_WEIGHTS,
  FeihuaDifficulty,
  FeihuaQuestionType,
  FeihuaRound,
  FeihuaSentence,
  TYPE_MIX,
} from "./types";

const OPTION_COUNT = 4;
const DISTRACTOR_COUNT = OPTION_COUNT - 1;

/** 按难度过滤句子（高档位包含低档位语料） */
export function filterByDifficulty(
  sentences: FeihuaSentence[],
  difficulty: FeihuaDifficulty,
): FeihuaSentence[] {
  const [min, max] = DIFFICULTY_RANGE[difficulty];
  const scoped = sentences.filter((s) => s.difficulty >= min && s.difficulty <= max);
  // 兜底：该档位语料不足时回退全量，保证可出题
  return scoped.length > 0 ? scoped : sentences;
}

/** 素材稳定 key：诗句 + 题型 */
export function materialKey(sentence: FeihuaSentence, type: FeihuaQuestionType): string {
  return `${sentence.id}:${type}`;
}

function shuffleOptions(options: string[], rand: () => number): string[] {
  const out = [...options];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function toRound(
  type: FeihuaQuestionType,
  target: FeihuaSentence,
  lingChar: string,
  prompt: string,
  options: string[],
  correct: string,
  roundIndex: number,
): FeihuaRound {
  return {
    roundIndex,
    type,
    prompt,
    options,
    answerIndex: options.indexOf(correct),
    sourceKey: materialKey(target, type),
    meta: {
      lingChar,
      sentence: target.text,
      poemTitle: target.poemTitle,
      poet: target.poet,
      dynasty: target.dynasty,
    },
  };
}

/** 寻句题：目标句含令字，干扰句不含 */
function buildContains(
  target: FeihuaSentence,
  scoped: FeihuaSentence[],
  lingIndex: Map<string, FeihuaSentence[]>,
  roundIndex: number,
  rand: () => number,
): FeihuaRound | null {
  const charsInTarget = [...lingIndex.keys()].filter((ch) =>
    target.text.includes(ch),
  );
  // 多个令字命中时随机尝试，直到干扰句凑得齐
  for (const char of sample(charsInTarget, charsInTarget.length, rand)) {
    const pool = withoutCharPool(scoped, char, target.id);
    if (pool.length < DISTRACTOR_COUNT) continue;
    const distractors = pickDistractors(
      pool.map((s) => s.text),
      target.text,
      DISTRACTOR_COUNT,
      rand,
    );
    if (distractors.length < DISTRACTOR_COUNT) continue;
    const options = shuffleOptions([...distractors, target.text], rand);
    return toRound(
      FeihuaQuestionType.FIND_CONTAINS,
      target,
      char,
      "",
      options,
      target.text,
      roundIndex,
    );
  }
  return null;
}

/** 挑白题：目标句不含令字，干扰句含字 */
function buildMissing(
  target: FeihuaSentence,
  lingIndex: Map<string, FeihuaSentence[]>,
  roundIndex: number,
  rand: () => number,
): FeihuaRound | null {
  const charsNotInTarget = [...lingIndex.keys()].filter(
    (ch) => !target.text.includes(ch),
  );
  for (const char of sample(charsNotInTarget, charsNotInTarget.length, rand)) {
    const pool = withCharPool(lingIndex, char, target.id);
    if (pool.length < DISTRACTOR_COUNT) continue;
    const distractors = pickDistractors(
      pool.map((s) => s.text),
      target.text,
      DISTRACTOR_COUNT,
      rand,
    );
    if (distractors.length < DISTRACTOR_COUNT) continue;
    const options = shuffleOptions([...distractors, target.text], rand);
    return toRound(
      FeihuaQuestionType.FIND_MISSING,
      target,
      char,
      "",
      options,
      target.text,
      roundIndex,
    );
  }
  return null;
}

/** 猜令题：题干为诗句，选句中含有的令字 */
function buildGuessChar(
  target: FeihuaSentence,
  lingIndex: Map<string, FeihuaSentence[]>,
  roundIndex: number,
  rand: () => number,
): FeihuaRound | null {
  const inChars = [...lingIndex.keys()].filter((ch) => target.text.includes(ch));
  const char = sample(inChars, 1, rand)[0];
  if (!char) return null;
  const outChars = [...lingIndex.keys()].filter((ch) => !target.text.includes(ch));
  const distractors = pickDistractors(outChars, char, DISTRACTOR_COUNT, rand);
  if (distractors.length < DISTRACTOR_COUNT) return null;
  const options = shuffleOptions([...distractors, char], rand);
  return toRound(
    FeihuaQuestionType.GUESS_CHAR,
    target,
    char,
    target.text,
    options,
    char,
    roundIndex,
  );
}

function buildRound(
  type: FeihuaQuestionType,
  target: FeihuaSentence,
  scoped: FeihuaSentence[],
  lingIndex: Map<string, FeihuaSentence[]>,
  roundIndex: number,
  rand: () => number,
): FeihuaRound | null {
  switch (type) {
    case FeihuaQuestionType.FIND_CONTAINS:
      return buildContains(target, scoped, lingIndex, roundIndex, rand);
    case FeihuaQuestionType.FIND_MISSING:
      return buildMissing(target, lingIndex, roundIndex, rand);
    case FeihuaQuestionType.GUESS_CHAR:
      return buildGuessChar(target, lingIndex, roundIndex, rand);
  }
}

type PassMode = { skipExcluded: boolean; skipUsed: boolean };
const PASSES: PassMode[] = [
  // 第一轮：只用没出过的素材，且同一句全局只作一次题干
  { skipExcluded: true, skipUsed: true },
  // 语料见底：允许跨局旧题
  { skipExcluded: false, skipUsed: true },
  // 再见底：允许本局内句子换题型复用
  { skipExcluded: false, skipUsed: false },
];

/**
 * 出题主入口：生成一轮完整对局
 *
 * 题型按档位配方循环（每轮循环洗牌起始题型），句子按难度加权抽样；
 * 没见过的素材优先，语料见底逐级回退，保证尽量凑满 count。
 */
export function buildRounds(
  poems: PoemCorpusItem[],
  options: BuildRoundsOptions,
): FeihuaRound[] {
  const { difficulty, count = 10, excludeKeys = [] } = options;
  const rand = mulberry32(options.seed ?? Date.now());

  const all = buildSentences(poems);
  let scoped = filterByDifficulty(all, difficulty);
  let lingIndex = buildLingIndex(scoped);
  // 令字为空（极小语料）时回退全量句子
  if (lingIndex.size === 0) {
    scoped = all;
    lingIndex = buildLingIndex(scoped);
  }
  if (lingIndex.size === 0 || scoped.length < OPTION_COUNT) return [];

  const weights = DIFFICULTY_WEIGHTS[difficulty];
  const weightOf = (s: FeihuaSentence) => weights[s.difficulty - 1] ?? 0.1;
  const ordered = weightedOrder(scoped, weightOf, rand);
  const excluded = new Set(excludeKeys);

  const rounds: FeihuaRound[] = [];
  /** 本局已作过题干的句子 / 已作过正确答案的诗句或字（防同局重复） */
  const usedTargetIds = new Set<string>();
  const seenCorrect = new Set<string>();

  for (const pass of PASSES) {
    if (rounds.length >= count) break;
    // 每题型独立游标遍历加权句序
    const cursors: Record<FeihuaQuestionType, number> = {
      [FeihuaQuestionType.FIND_CONTAINS]: 0,
      [FeihuaQuestionType.FIND_MISSING]: 0,
      [FeihuaQuestionType.GUESS_CHAR]: 0,
    };
    let cycle = sample(TYPE_MIX[difficulty], TYPE_MIX[difficulty].length, rand);
    let cyclePos = 0;
    // 安全阀：本 pass 每种题型最多把句表扫两遍
    let safety = 0;
    const maxSafety = ordered.length * TYPE_MIX[difficulty].length * 2;

    while (rounds.length < count && safety++ < maxSafety) {
      if (cyclePos >= cycle.length) {
        cycle = sample(TYPE_MIX[difficulty], TYPE_MIX[difficulty].length, rand);
        cyclePos = 0;
      }
      const type = cycle[cyclePos++];

      let round: FeihuaRound | null = null;
      let chosenTarget: FeihuaSentence | null = null;
      while (cursors[type] < ordered.length) {
        const target = ordered[cursors[type]++];
        if (pass.skipUsed && usedTargetIds.has(target.id)) continue;
        if (pass.skipExcluded && excluded.has(materialKey(target, type))) continue;
        const candidate = buildRound(
          type,
          target,
          scoped,
          lingIndex,
          rounds.length,
          rand,
        );
        if (!candidate) continue;
        const correctText = candidate.options[candidate.answerIndex];
        if (seenCorrect.has(correctText)) continue;
        round = candidate;
        chosenTarget = target;
        break;
      }

      if (round && chosenTarget) {
        usedTargetIds.add(chosenTarget.id);
        seenCorrect.add(round.options[round.answerIndex]);
        rounds.push(round);
      }
    }
  }

  return rounds;
}
