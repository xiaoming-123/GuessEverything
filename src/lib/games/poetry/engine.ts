/**
 * 诗词出题引擎 · 纯函数
 *
 * 输入语料 + 参数，输出完整轮次（含答案）。
 * 答案剥离（toRoundView）在服务端 API 层执行，引擎不负责。
 */

import {
  mulberry32,
  charDistractorPool,
  dynastyDistractorPool,
  fillCharPositions,
  nextLineDistractorPool,
  pickDistractors,
  poetDistractorPool,
  titleDistractorPool,
} from "./distractors";
import { weightedOrder } from "../sampling";
import {
  PoetryQuestionType,
  PoetryRound,
  PoetryStage,
  PoemCorpusItem,
  STAGE_GRADE_RANGE,
  BuildRoundsOptions,
  RankBuildOptions,
  RankedBuildResult,
} from "./types";
import { countFor, preferColdFor, windowFor } from "./rank";

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

/**
 * 素材稳定 key：诗 + 句位 + 题型（同一「知识点」的稳定标识）。
 * FILL_CHAR 追加挖字位 pos（四段格式 poemId:lineIndex:FILL_CHAR:pos）——
 * 同句不同挖字位是两个不同素材（防互斥）；其余题型三段格式不变。
 */
export function materialKey(
  item: PoemCorpusItem,
  lineIndex: number,
  type: PoetryQuestionType,
  pos?: number,
): string {
  if (type === PoetryQuestionType.FILL_CHAR && pos !== undefined) {
    return `${item.id}:${lineIndex}:${type}:${pos}`;
  }
  return `${item.id}:${lineIndex}:${type}`;
}

/** FILL_CHAR 挖字 prompt：line 第 pos 字替换为「□」（保留原句其余文字） */
export function fillCharPrompt(line: string, pos: number): string {
  return `${line.slice(0, pos)}□${line.slice(pos + 1)}`;
}

/**
 * 题面 key（去重维度）。
 *
 * 题目规范身份 = 稳定 materialKey（poemId + lineIndex + questionType）。
 * 但「换 ID 不改题面」不应绕过去重：两首诗内容逐字相同、同句位、同题型时，
 * 它们的**题面**（prompt + options 素材）实际是同一道题，应视为重复。
 * faceKey 用「题干 + 正确答案」归一化题面，跨不同 poemId 也能识别同题面重复。
 *
 * FILL_CHAR（review A4-3）：prompt 含挖字位 pos（□ 位置不同即不同题面），
 * correct = 被挖字，显式入 key 保证与 materialKey 同粒度；其余题型忽略 pos。
 *
 * 注意：整首诗可在不同知识点（不同 lineIndex / 题型）再出现——
 * 这是「同诗不同题」，不算重复；严格去重的粒度是「素材 key + 题面」，
 * 不是「同诗永不出现」。
 */
export function faceKey(
  item: PoemCorpusItem,
  lineIndex: number,
  type: PoetryQuestionType,
  pos?: number,
): string {
  let prompt: string;
  let correct: string;
  if (type === PoetryQuestionType.FILL_CHAR) {
    const p = pos ?? 0;
    prompt = fillCharPrompt(item.lines[lineIndex], p);
    correct = item.lines[lineIndex][p];
    return `${type}|${prompt}|${correct}|${p}`;
  }
  prompt =
    type === PoetryQuestionType.COMPLETE_NEXT
      ? item.lines[lineIndex]
      : pickQuote(item, lineIndex);
  // DYNASTY_PICK 的正确答案是朝代（不是下一句！）——漏此分支会让 faceKey 的
  // correct 段错成 lines[lineIndex+1]，已见排除对新题型静默失效。
  correct =
    type === PoetryQuestionType.GUESS_POET
      ? item.poet
      : type === PoetryQuestionType.GUESS_TITLE
        ? item.title
        : type === PoetryQuestionType.DYNASTY_PICK
          ? item.dynasty
          : item.lines[lineIndex + 1];
  return `${type}|${prompt}|${correct}`;
}

/**
 * 由一局轮次（round）直接重构其题面 key（review A4-2 推荐路径）。
 *
 * 引擎 materializeRound 产出的 round.prompt 与 round.options[answerIndex]
 * 本就与 faceKey 的 prompt/correct 逐字节相同（同一代码路径生成），
 * FILL_CHAR 的 meta.pos 亦与 faceKey 的 pos 维度一致——故可直接由
 * `type|prompt|correct[|pos]` 重构，无需反查语料、更无需"两处素材枚举
 * 必须同口径"的隐式耦合。collectSeenKeys 落库已见题面时走本函数，
 * 新题型（FILL_CHAR/DYNASTY_PICK）的已见题面排除天然生效。
 */
export function roundFaceKey(round: PoetryRound): string {
  if (round.type === PoetryQuestionType.FILL_CHAR) {
    const pos = round.meta.pos ?? 0;
    return `${round.type}|${round.prompt}|${round.options[round.answerIndex]}|${pos}`;
  }
  return `${round.type}|${round.prompt}|${round.options[round.answerIndex]}`;
}

/**
 * 将「素材（item + lineIndex + type [+ pos]）+ 干扰项池 + 随机源」实例化为完整一轮。
 * 引擎与容量审计共用此函数，保证「出卷时认为可出的题」与「审计统计的可出题」口径一致。
 * FILL_CHAR 传 pos（挖字位）；其余题型 pos 忽略。
 */
export function materializeRound(
  type: PoetryQuestionType,
  item: PoemCorpusItem,
  lineIndex: number,
  pool: PoemCorpusItem[],
  roundIndex: number,
  rand: () => number,
  strictOptions = false,
  pos?: number,
): PoetryRound {
  const sourceKey = materialKey(item, lineIndex, type, type === PoetryQuestionType.FILL_CHAR ? pos : undefined);
  let prompt: string;
  let correct: string;
  let distractorPool: string[];

  switch (type) {
    case PoetryQuestionType.GUESS_POET: {
      prompt = pickQuote(item, lineIndex);
      correct = item.poet;
      distractorPool = poetDistractorPool(pool, item.poet, item.dynasty);
      break;
    }
    case PoetryQuestionType.GUESS_TITLE: {
      prompt = pickQuote(item, lineIndex);
      correct = item.title;
      distractorPool = titleDistractorPool(pool, item.title, item.poet);
      break;
    }
    case PoetryQuestionType.COMPLETE_NEXT: {
      prompt = item.lines[lineIndex];
      correct = item.lines[lineIndex + 1];
      distractorPool = nextLineDistractorPool(pool, item.id, [prompt, correct]);
      break;
    }
    case PoetryQuestionType.FILL_CHAR: {
      const p = pos ?? 0;
      prompt = fillCharPrompt(item.lines[lineIndex], p);
      correct = item.lines[lineIndex][p];
      // 干扰字池 = 同诗其余 CJK 字 + 同朝代其他诗 CJK 字（去重、≠correct，取 3）
      distractorPool = charDistractorPool(pool, item, correct);
      break;
    }
    case PoetryQuestionType.DYNASTY_PICK: {
      prompt = pickQuote(item, lineIndex);
      correct = item.dynasty;
      // 干扰朝代：语料内真实朝代频次降序 + 白名单补位（review A1）
      distractorPool = dynastyDistractorPool(pool, item.dynasty);
      break;
    }
  }

  const distractors = pickDistractors(distractorPool, correct, DISTRACTOR_COUNT, rand);
  // 干扰项不足 3 个时从同题干诗句兜底，仍不足则原题跳过逻辑由调用方过滤
  if (!strictOptions && distractors.length < DISTRACTOR_COUNT) {
    const fallback = pickDistractors(
      pool.flatMap((p) => p.lines),
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
      grade: item.grade,
      lineIndex,
      ...(type === PoetryQuestionType.COMPLETE_NEXT
        ? { nextLine: item.lines[lineIndex + 1] }
        : {}),
      ...(type === PoetryQuestionType.FILL_CHAR && pos !== undefined ? { pos } : {}),
    },
  };
}

/** 单题构造：根据题型生成一轮（委托 materializeRound，与容量审计同口径） */
function buildRound(
  type: PoetryQuestionType,
  item: PoemCorpusItem,
  lineIndex: number,
  corpus: PoemCorpusItem[],
  roundIndex: number,
  rand: () => number,
): PoetryRound {
  return materializeRound(type, item, lineIndex, corpus, roundIndex, rand);
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

/**
 * 官阶严格出卷入口（诗词升官模式专用，纯函数）。
 *
 * 红线（review 任务书 / 设计文档）：
 * - **严格不重复**：`excludeKeys`（已见素材 key）一律排除；另按 `faceKey` 排除
 *   「题面相同」的素材，防止换 poemId 不改题面绕过。会试 / 科考 / 每日题同此规则。
 * - **不越级**：只从 `rankId` 对应的 grade 窗口取素材，绝不借更高官阶的题。
 * - **不自动晋升**：题量不足返回 `{ ok:false, reason:"INSUFFICIENT_CAPACITY" }`，
 *   由上层「保留进度、等待扩容」，绝不返回不足题数的正常试卷、绝不自动跳阶。
 * - **种子确定性**：同 `seed` 同语料同排除集，输出逐字一致。
 *
 * 窗口内若「有效素材」不足（如某 grade 档语料缺、或冷门加权后过少），
 * 优先在同窗口内用其他题型 / 其他句位补齐，仍不足即判容量不足。
 */
export function buildRankedRounds(
  corpus: PoemCorpusItem[],
  options: RankBuildOptions,
): RankedBuildResult {
  const required = countFor(options.rankId, options.kind);
  const [lo, hi] = windowFor(options.rankId, options.kind);
  const pool = rankedRoundPool(corpus, options);
  if (pool.length < required) {
    return {
      ok: false,
      reason: corpus.some((p) => p.grade >= lo && p.grade <= hi)
        ? "INSUFFICIENT_CAPACITY" : "EMPTY_CORPUS",
      available: pool.length,
      required,
    };
  }
  return { ok: true, rounds: pool.slice(0, required) };
}

/** 真实可用题池：与正式出卷共用筛选，供只读容量审计使用。 */
export function rankedRoundPool(
  corpus: PoemCorpusItem[],
  options: RankBuildOptions,
): PoetryRound[] {
  const { rankId, kind, seed, excludeKeys = [] } = options;
  const [minGrade, maxGrade] = windowFor(rankId, kind);

  // 窗口内语料（只取本官阶窗口，绝不越级）
  const scoped = corpus.filter((p) => p.grade >= minGrade && p.grade <= maxGrade);
  if (scoped.length === 0) {
    return [];
  }

  const rand = mulberry32(seed ?? Date.now());
  const preferCold = preferColdFor(rankId);
  const excludeSet = new Set(excludeKeys);
  const excludeFaces = new Set(
    [...(options.excludeFaces ?? []), ...excludeKeys
      .map((k) => faceKeyOfKey(corpus, k))
      .filter((v): v is string => v !== undefined)],
  );

  // 枚举窗口内所有可出卷素材（每首诗每个合法句位 × 3 基础题型 + D3 新题型）
  // D3 题型混合（详设 §3.2 / review B9）：rankId < 3 仅基础 3 型（低阶不混入）；
  // rankId >= 3 起 FILL_CHAR / DYNASTY_PICK 各按 30% 概率追加（seed 确定可复现）。
  type Material = {
    item: PoemCorpusItem;
    lineIndex: number;
    type: PoetryQuestionType;
    /** FILL_CHAR 挖字位（素材枚举时 seed 确定性选定，保证引擎/审计/faceKey 三处同 pos） */
    pos?: number;
  };
  const materials: Material[] = [];
  for (const item of scoped) {
    for (let i = 0; i < item.lines.length - 1; i++) {
      materials.push({ item, lineIndex: i, type: PoetryQuestionType.GUESS_POET });
      materials.push({ item, lineIndex: i, type: PoetryQuestionType.GUESS_TITLE });
      materials.push({ item, lineIndex: i, type: PoetryQuestionType.COMPLETE_NEXT });
      if (rankId >= 3) {
        if (rand() < 0.3) {
          // DYNASTY_PICK：每句 1 个候选（选项 = 朝代名，无需 pos）
          materials.push({ item, lineIndex: i, type: PoetryQuestionType.DYNASTY_PICK });
        }
        if (rand() < 0.3) {
          // FILL_CHAR：每句 1 个候选，pos 确定性随机（CJK 字位，句中 CJK 字数 ≥ 2）
          const positions = fillCharPositions(item.lines[i]);
          if (positions.length > 0) {
            const pos = positions[Math.floor(rand() * positions.length)];
            materials.push({ item, lineIndex: i, type: PoetryQuestionType.FILL_CHAR, pos });
          }
        }
      }
    }
  }

  // 过滤已见（素材 key 或 同题面）
  const fresh = materials.filter((m) => {
    const k = materialKey(m.item, m.lineIndex, m.type, m.pos);
    if (excludeSet.has(k)) return false;
    if (excludeFaces.has(faceKey(m.item, m.lineIndex, m.type, m.pos))) return false;
    return true;
  });

  // 冷门加权：preferCold 时按 (cold+1) 加权洗牌；否则均匀洗牌
  const shuffled = weightedOrder(
    fresh,
    (m) => (preferCold ? (m.item.cold ?? 0) + 1 : 1),
    rand,
  );

  const rounds: PoetryRound[] = [];
  const seenPrompts = new Set<string>();
  const seenFaces = new Set<string>();
  for (const m of shuffled) {
    const round = materializeRound(
      m.type,
      m.item,
      m.lineIndex,
      scoped,
      rounds.length,
      rand,
      true,
      m.type === PoetryQuestionType.FILL_CHAR ? m.pos : undefined,
    );
    if (round.answerIndex < 0 || round.options.length !== OPTION_COUNT ||
        new Set(round.options).size !== OPTION_COUNT) continue;
    const face = faceKey(m.item, m.lineIndex, m.type, m.pos);
    // 局内去重：同题面 / 同题干不重复出
    if (seenPrompts.has(round.prompt) || seenFaces.has(face)) continue;
    seenPrompts.add(round.prompt);
    seenFaces.add(face);
    rounds.push(round);
  }

  return rounds;
}

/**
 * 由素材 key 反查其在语料中的题面 key。
 * 用于把「已见素材 key」扩展为「已见题面」，防止换 poemId 绕过去重。
 *
 * 支持 D3 四段 FILL_CHAR key（poemId:lineIndex:FILL_CHAR:pos，review A4-1）：
 * 末段纯数字且倒数第二段为 FILL_CHAR 时再 pop 一次取 pos。
 * 题型白名单含 FILL_CHAR / DYNASTY_PICK——只改 materialKey 会让
 * 四段 key pop 出 pos 当 type → NaN → return undefined → 已见 FILL_CHAR
 * 的题面排除静默失效。
 */
export function faceKeyOfKey(
  corpus: PoemCorpusItem[],
  key: string,
): string | undefined {
  const parts = key.split(":");
  let typeStr: string;
  let pos: number | undefined;
  // 四段 FILL_CHAR（id:lineIndex:FILL_CHAR:pos，id 可含冒号 → 从尾部锚定解析）：
  // 末段纯数字且倒数第二段为 FILL_CHAR 时，末段是 pos 而非 type。
  if (
    parts.length >= 4 &&
    parts[parts.length - 2] === PoetryQuestionType.FILL_CHAR &&
    /^\d+$/.test(parts[parts.length - 1])
  ) {
    pos = Number(parts[parts.length - 1]);
    typeStr = parts[parts.length - 2];
  } else {
    typeStr = parts[parts.length - 1];
  }
  // lineIndex = type 前一段；id = lineIndex 之前的全部（可含冒号）
  const lineOffset = parts.length - (pos !== undefined ? 3 : 2);
  const lineStr = parts[lineOffset];
  const id = parts.slice(0, lineOffset).join(":");
  const lineIndex = Number(lineStr);
  const item = corpus.find((p) => p.id === id);
  if (!item || !Number.isInteger(lineIndex)) return undefined;
  const type = typeStr as PoetryQuestionType;
  const TYPES: string[] = [
    PoetryQuestionType.GUESS_POET,
    PoetryQuestionType.GUESS_TITLE,
    PoetryQuestionType.COMPLETE_NEXT,
    PoetryQuestionType.FILL_CHAR,
    PoetryQuestionType.DYNASTY_PICK,
  ];
  if (!TYPES.includes(typeStr)) return undefined;
  if (lineIndex < 0 || lineIndex >= item.lines.length) return undefined;
  // COMPLETE_NEXT 需要下一句存在；FILL_CHAR / DYNASTY_PICK 只需本句合法
  if (type === PoetryQuestionType.COMPLETE_NEXT && lineIndex + 1 >= item.lines.length) {
    return undefined;
  }
  if (type === PoetryQuestionType.FILL_CHAR && pos === undefined) return undefined;
  return faceKey(item, lineIndex, type, pos);
}
