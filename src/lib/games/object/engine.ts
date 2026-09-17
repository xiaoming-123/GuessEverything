/**
 * 物品出题引擎 · 纯函数
 *
 * 输入语料 + 参数，输出完整轮次（含答案）。
 * 答案剥离（toRoundView）在服务端 API 层执行，引擎不负责。
 */

import {
  categoryDistractorPool,
  mulberry32,
  objectDistractorPool,
  pickDistractors,
} from "./distractors";
import {
  CATEGORY_LABEL,
  ObjectCorpusItem,
  ObjectDifficulty,
  ObjectQuestionType,
  ObjectRound,
  BuildRoundsOptions,
  DIFFICULTY_RANGE,
  DIFFICULTY_WEIGHTS,
} from "@/lib/games/object/types";
import { weightedOrder } from "@/lib/games/sampling";

const OPTION_COUNT = 4;
const DISTRACTOR_COUNT = OPTION_COUNT - 1;

/** 按难度过滤语料（高档位包含低档位语料） */
export function filterByDifficulty(
  corpus: ObjectCorpusItem[],
  difficulty: ObjectDifficulty,
): ObjectCorpusItem[] {
  const [min, max] = DIFFICULTY_RANGE[difficulty];
  const scoped = corpus.filter((o) => o.difficulty >= min && o.difficulty <= max);
  // 兜底：该档位语料不足时回退全量，保证可出题
  return scoped.length > 0 ? scoped : corpus;
}

/** 组装 4 选 1 选项并洗牌，返回选项与答案索引 */
function assembleOptions(
  distractors: string[],
  correct: string,
  rand: () => number,
): { options: string[]; answerIndex: number } | null {
  if (distractors.length < DISTRACTOR_COUNT) return null;
  const options = distractors.slice(0, DISTRACTOR_COUNT);
  options.push(correct);
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { options, answerIndex: options.indexOf(correct) };
}

/** 素材稳定 key：物品 + 题型 */
export function materialKey(item: ObjectCorpusItem, type: ObjectQuestionType): string {
  return `${item.id}:${type}`;
}

/** 单题构造：根据题型生成一轮 */
function buildRound(
  type: ObjectQuestionType,
  item: ObjectCorpusItem,
  corpus: ObjectCorpusItem[],
  roundIndex: number,
  rand: () => number,
): ObjectRound | null {
  const sourceKey = materialKey(item, type);
  let prompt: string;
  let clues: string[];
  let correct: string;
  let assembled: { options: string[]; answerIndex: number } | null;

  switch (type) {
    case ObjectQuestionType.GUESS_FROM_CLUES: {
      clues = item.clues;
      prompt = clues[0];
      correct = item.name;
      const pool = objectDistractorPool(corpus, item.name, item.category);
      assembled = assembleOptions(
        pickDistractors(pool, correct, DISTRACTOR_COUNT, rand),
        correct,
        rand,
      );
      break;
    }
    case ObjectQuestionType.GUESS_FROM_RIDDLE: {
      if (!item.riddle) return null;
      clues = [item.riddle];
      prompt = item.riddle;
      correct = item.name;
      const pool = objectDistractorPool(corpus, item.name, item.category);
      assembled = assembleOptions(
        pickDistractors(pool, correct, DISTRACTOR_COUNT, rand),
        correct,
        rand,
      );
      break;
    }
    case ObjectQuestionType.GUESS_CATEGORY: {
      clues = item.clues.slice(0, 1);
      prompt = `「${item.name}」属于哪一类？`;
      correct = CATEGORY_LABEL[item.category];
      assembled = assembleOptions(
        pickDistractors(categoryDistractorPool(item.category), correct, DISTRACTOR_COUNT, rand),
        correct,
        rand,
      );
      break;
    }
  }

  if (!assembled) return null;

  return {
    roundIndex,
    type,
    prompt,
    clues,
    options: assembled.options,
    answerIndex: assembled.answerIndex,
    sourceKey,
    meta: {
      name: item.name,
      category: item.category,
      clues: item.clues,
      ...(item.riddle ? { riddle: item.riddle } : {}),
    },
  };
}

/**
 * 出题主入口：生成一轮完整对局
 *
 * 每件物品产出线索题 / 分类题素材，有谜语的追加谜语题，
 * 洗牌后逐个出题，同题面不重复。
 */
export function buildRounds(
  corpus: ObjectCorpusItem[],
  options: BuildRoundsOptions,
): ObjectRound[] {
  const { difficulty, count = 10, excludeKeys = [] } = options;
  const rand = mulberry32(options.seed ?? Date.now());
  const scoped = filterByDifficulty(corpus, difficulty);

  type Material = {
    item: ObjectCorpusItem;
    type: ObjectQuestionType;
  };
  const materials: Material[] = [];
  for (const item of scoped) {
    materials.push({ item, type: ObjectQuestionType.GUESS_FROM_CLUES });
    materials.push({ item, type: ObjectQuestionType.GUESS_CATEGORY });
    if (item.riddle) {
      materials.push({ item, type: ObjectQuestionType.GUESS_FROM_RIDDLE });
    }
  }

  // 加权抽样：高难档优先高难素材；没见过的素材优先，语料见底再循环旧题
  const weights = DIFFICULTY_WEIGHTS[difficulty];
  const weightOf = (m: Material) => weights[m.item.difficulty - 1] ?? 0.1;
  const excluded = new Set(excludeKeys);
  const fresh = weightedOrder(
    materials.filter((m) => !excluded.has(materialKey(m.item, m.type))),
    weightOf,
    rand,
  );
  const stale = weightedOrder(
    materials.filter((m) => excluded.has(materialKey(m.item, m.type))),
    weightOf,
    rand,
  );
  const ordered = [...fresh, ...stale];

  const rounds: ObjectRound[] = [];
  const seenPrompts = new Set<string>();
  for (const m of ordered) {
    if (rounds.length >= count) break;
    const round = buildRound(m.type, m.item, scoped, rounds.length, rand);
    if (!round) continue;
    if (seenPrompts.has(round.prompt)) continue;
    if (round.answerIndex < 0) continue;
    seenPrompts.add(round.prompt);
    rounds.push(round);
  }

  return rounds;
}
