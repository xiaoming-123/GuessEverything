/**
 * 演员出题引擎 · 纯函数
 *
 * 输入语料 + 参数，输出完整轮次（含答案）。
 * 答案剥离（toRoundView）在服务端 API 层执行，引擎不负责。
 */

import {
  actorDistractorPool,
  mulberry32,
  pickDistractors,
  workDistractorPool,
} from "./distractors";
import {
  ActorCorpusItem,
  ActorDifficulty,
  ActorQuestionType,
  ActorRegion,
  ActorRound,
  ActorRole,
  BuildRoundsOptions,
  DIFFICULTY_RANGE,
  DIFFICULTY_WEIGHTS,
} from "@/lib/games/actor/types";
import { weightedOrder } from "@/lib/games/sampling";

const OPTION_COUNT = 4;
const DISTRACTOR_COUNT = OPTION_COUNT - 1;
/** 猜演员题型展示的线索数量 */
const WORK_CLUE_COUNT = 2;
const ROLE_CLUE_COUNT = 2;

/** 按难度过滤语料（高档位包含低档位语料） */
export function filterByDifficulty(
  corpus: ActorCorpusItem[],
  difficulty: ActorDifficulty,
): ActorCorpusItem[] {
  const [min, max] = DIFFICULTY_RANGE[difficulty];
  const scoped = corpus.filter((a) => a.difficulty >= min && a.difficulty <= max);
  // 兜底：该档位语料不足时回退全量，保证可出题
  return scoped.length > 0 ? scoped : corpus;
}

/** 从数组中随机取 n 个不重复元素 */
function sample<T>(list: T[], n: number, rand: () => number): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

function formatWorks(works: string[]): string {
  return works.map((w) => `《${w}》`).join("");
}

function formatRoles(roles: string[]): string {
  return roles.map((r) => `「${r}」`).join("、");
}

/** 素材稳定 key：演员 + 题型（同演员三题分别去重） */
export function materialKey(item: ActorCorpusItem, type: ActorQuestionType): string {
  return `${item.id}:${type}`;
}

/** 单题构造：根据题型生成一轮 */
function buildRound(
  type: ActorQuestionType,
  item: ActorCorpusItem,
  corpus: ActorCorpusItem[],
  roundIndex: number,
  rand: () => number,
): ActorRound | null {
  const sourceKey = materialKey(item, type);
  let prompt: string;
  let correct: string;
  let pool: string[];
  let clueRole: ActorRole | undefined;

  switch (type) {
    case ActorQuestionType.GUESS_FROM_WORKS: {
      if (item.works.length < 2) return null;
      const clueWorks = sample(item.works, WORK_CLUE_COUNT, rand);
      prompt = `出演了${formatWorks(clueWorks)}等作品的演员是？`;
      correct = item.name;
      pool = actorDistractorPool(corpus, item.name, item.region);
      break;
    }
    case ActorQuestionType.GUESS_FROM_ROLES: {
      if (item.roles.length === 0) return null;
      const clueRoles = sample(
        item.roles.map((r) => r.role),
        ROLE_CLUE_COUNT,
        rand,
      );
      prompt = `因饰演${formatRoles(clueRoles)}等经典角色深入人心的演员是？`;
      correct = item.name;
      pool = actorDistractorPool(corpus, item.name, item.region);
      break;
    }
    case ActorQuestionType.GUESS_WORK: {
      if (item.roles.length === 0) return null;
      clueRole = sample(item.roles, 1, rand)[0];
      prompt = `${item.name} 饰演的「${clueRole.role}」出自哪部作品？`;
      correct = clueRole.work;
      pool = workDistractorPool(corpus, correct, item.id, item.region);
      break;
    }
  }

  const distractors = pickDistractors(pool, correct, DISTRACTOR_COUNT, rand);
  // 干扰项不足 3 个时从全池兜底
  if (distractors.length < DISTRACTOR_COUNT) {
    const fallbackPool =
      type === ActorQuestionType.GUESS_WORK
        ? corpus.flatMap((a) => a.works)
        : corpus.map((a) => a.name);
    const fallback = pickDistractors(
      fallbackPool,
      correct,
      DISTRACTOR_COUNT - distractors.length,
      rand,
    );
    distractors.push(...fallback);
  }
  if (distractors.length < DISTRACTOR_COUNT) return null;

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
      actorName: item.name,
      region: item.region as ActorRegion,
      works: item.works,
      roles: item.roles.map((r) => r.role),
      ...(type === ActorQuestionType.GUESS_WORK && clueRole
        ? { role: clueRole.role }
        : {}),
    },
  };
}

/**
 * 出题主入口：生成一轮完整对局
 *
 * 每位演员产出三种题型素材，洗牌后逐个出题，同题面不重复。
 */
export function buildRounds(
  corpus: ActorCorpusItem[],
  options: BuildRoundsOptions,
): ActorRound[] {
  const { difficulty, count = 10, excludeKeys = [] } = options;
  const rand = mulberry32(options.seed ?? Date.now());
  const scoped = filterByDifficulty(corpus, difficulty);

  // 每位演员 × 三种题型
  type Material = {
    item: ActorCorpusItem;
    type: ActorQuestionType;
  };
  const materials: Material[] = [];
  for (const item of scoped) {
    materials.push({ item, type: ActorQuestionType.GUESS_FROM_WORKS });
    materials.push({ item, type: ActorQuestionType.GUESS_FROM_ROLES });
    materials.push({ item, type: ActorQuestionType.GUESS_WORK });
  }

  // 加权抽样：按档位对语料难度加权；没见过的素材优先，语料见底再循环旧题
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

  const rounds: ActorRound[] = [];
  const seenPrompts = new Set<string>();
  for (const m of ordered) {
    if (rounds.length >= count) break;
    const round = buildRound(
      m.type,
      m.item,
      scoped,
      rounds.length,
      rand,
    );
    if (!round) continue;
    if (seenPrompts.has(round.prompt)) continue;
    if (round.answerIndex < 0) continue;
    seenPrompts.add(round.prompt);
    rounds.push(round);
  }

  return rounds;
}
