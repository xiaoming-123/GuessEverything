/**
 * 诗词出题引擎 · 纯函数
 *
 * 输入语料 + 参数，输出完整轮次（含答案）。
 * 答案剥离（toRoundView）在服务端 API 层执行，引擎不负责。
 */

import {
  mulberry32,
  nextLineDistractorPool,
  pickDistractors,
  poetDistractorPool,
  titleDistractorPool,
} from "./distractors";
import {
  PoetryQuestionType,
  PoetryRound,
  PoetryStage,
  PoemCorpusItem,
  STAGE_GRADE_RANGE,
  BuildRoundsOptions,
} from "./types";

const OPTION_COUNT = 4;
const DISTRACTOR_COUNT = OPTION_COUNT - 1;

/** 按学段过滤语料 */
export function filterByStage(
  corpus: PoemCorpusItem[],
  stage: PoetryStage,
): PoemCorpusItem[] {
  const [min, max] = STAGE_GRADE_RANGE[stage];
  const scoped = corpus.filter((p) => p.grade >= min && p.grade <= max);
  // 兜底：该学段语料不足时回退全量，保证可出题
  return scoped.length > 0 ? scoped : corpus;
}

/** 取一句名句（两联拼接，优先名句标记） */
export function pickQuote(item: PoemCorpusItem, lineIndex: number): string {
  const joiner = "，";
  const a = item.lines[lineIndex];
  const b = item.lines[lineIndex + 1];
  return b !== undefined ? `${a}${joiner}${b}` : a;
}

/** 素材稳定 key：诗 + 句位 + 题型 */
export function materialKey(
  item: PoemCorpusItem,
  lineIndex: number,
  type: PoetryQuestionType,
): string {
  return `${item.id}:${lineIndex}:${type}`;
}

/** 单题构造：根据题型生成一轮 */
function buildRound(
  type: PoetryQuestionType,
  item: PoemCorpusItem,
  lineIndex: number,
  corpus: PoemCorpusItem[],
  roundIndex: number,
  rand: () => number,
): PoetryRound {
  const sourceKey = materialKey(item, lineIndex, type);
  let prompt: string;
  let correct: string;
  let pool: string[];

  switch (type) {
    case PoetryQuestionType.GUESS_POET: {
      prompt = pickQuote(item, lineIndex);
      correct = item.poet;
      pool = poetDistractorPool(corpus, item.poet, item.dynasty);
      break;
    }
    case PoetryQuestionType.GUESS_TITLE: {
      prompt = pickQuote(item, lineIndex);
      correct = item.title;
      pool = titleDistractorPool(corpus, item.title, item.poet);
      break;
    }
    case PoetryQuestionType.COMPLETE_NEXT: {
      prompt = item.lines[lineIndex];
      correct = item.lines[lineIndex + 1];
      pool = nextLineDistractorPool(corpus, item.id, [prompt, correct]);
      break;
    }
  }

  const distractors = pickDistractors(pool, correct, DISTRACTOR_COUNT, rand);
  // 干扰项不足 3 个时从同题干诗句兜底，仍不足则原题跳过逻辑由调用方过滤
  if (distractors.length < DISTRACTOR_COUNT) {
    const fallback = pickDistractors(
      corpus.flatMap((p) => p.lines),
      correct,
      DISTRACTOR_COUNT - distractors.length,
      rand,
    );
    distractors.push(...fallback);
  }

  const options = [...distractors, correct];
  // 选项洗牌
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  return {
    roundIndex,
    type,
    prompt,
    options,
    answerIndex: options.indexOf(correct),
    sourceKey,
    meta: {
      poemTitle: item.title,
      poet: item.poet,
      dynasty: item.dynasty,
      ...(type === PoetryQuestionType.COMPLETE_NEXT
        ? { nextLine: item.lines[lineIndex + 1] }
        : {}),
    },
  };
}

/**
 * 出题主入口：生成一轮完整对局
 *
 * @throws 当语料不足或合法轮次不足 count 时，尽量返回可用轮次（>=1）
 */
export function buildRounds(
  corpus: PoemCorpusItem[],
  options: BuildRoundsOptions,
): PoetryRound[] {
  const { stage, count = 10, excludeKeys = [] } = options;
  const rand = mulberry32(options.seed ?? Date.now());
  const scoped = filterByStage(corpus, stage);

  // 收集可出题素材：每首诗每个合法句位 × 三种题型
  type Material = {
    item: PoemCorpusItem;
    lineIndex: number;
    type: PoetryQuestionType;
  };
  const materials: Material[] = [];
  for (const item of scoped) {
    for (let i = 0; i < item.lines.length - 1; i++) {
      materials.push({ item, lineIndex: i, type: PoetryQuestionType.GUESS_POET });
      materials.push({ item, lineIndex: i, type: PoetryQuestionType.GUESS_TITLE });
      materials.push({ item, lineIndex: i, type: PoetryQuestionType.COMPLETE_NEXT });
    }
  }

  // 洗牌素材（保持洗牌后相对顺序，将未见过的素材前移，语料见底再用旧题）
  for (let i = materials.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [materials[i], materials[j]] = [materials[j], materials[i]];
  }
  const excluded = new Set(excludeKeys);
  materials.sort((a, b) => {
    const ak = excluded.has(materialKey(a.item, a.lineIndex, a.type)) ? 1 : 0;
    const bk = excluded.has(materialKey(b.item, b.lineIndex, b.type)) ? 1 : 0;
    return ak - bk;
  });

  const rounds: PoetryRound[] = [];
  const seenPrompts = new Set<string>();
  for (const m of materials) {
    if (rounds.length >= count) break;
    const round = buildRound(
      m.type,
      m.item,
      m.lineIndex,
      scoped,
      rounds.length,
      rand,
    );
    if (seenPrompts.has(round.prompt)) continue;
    if (round.answerIndex < 0) continue;
    seenPrompts.add(round.prompt);
    rounds.push(round);
  }

  return rounds;
}
