/**
 * 诗词升官 · 官阶体系 · 纯逻辑层（零依赖）
 *
 * 设计红线（见 docs/design/2026-09-17-poetry-rank-review-and-next.md）：
 * - 官阶数（10 阶 + 1 皇帝 Boss）管「称号密度 / 升官节奏」，
 *   难度档数（grade 窗口）管「内容 / 命题成本」，二者解耦。
 * - 难度随官阶整体上移（窗口整体后移），承诺「官阶难度档递增」，
 *   不承诺「逐题绝对递增」（受干扰项质量 / 题型 / 熟悉度影响，见设计文档 §2）。
 * - 布衣 → 皇帝是**架空称号路线**，文案不得宣称为真实官制（见 review 第 8 条）。
 *
 * 本文件零框架依赖：不 import next/*、@prisma/client、react、任何 IO，
 * 语料 / 随机数 / 配置一律参数注入，可独立单测。
 */

import type { RankKind } from "./types";

/** 普通研习每局题数 */
export const PRACTICE_COUNT = 10;
/** 科考（晋升大考）每局题数 */
export const EXAM_COUNT = 10;
/** 每日题题数 */
export const DAILY_COUNT = 1;
/** 皇帝登极大考题数 */
export const EMPEROR_COUNT = 15;

/** 单个官阶定义 */
export interface RankSpec {
  /** 0..9 普通官阶，10 = 皇帝（登极 Boss） */
  id: number;
  /** 稳定 key：BUYI | TONGSHENG | ... | CHENGXIANG | DIWANG */
  key: string;
  /** 称号（架空，非真实官制） */
  label: string;
  /** 一句话叙事（架空文案） */
  subtitle: string;
  /** 难度档 1..11（官阶难度档，单调递增）。用于校准题面/干扰项/题型，不承诺逐题绝对递增 */
  difficulty: number;
  /** 研习出卷 grade 区间 [min, max]（闭区间） */
  gradeWindow: [number, number];
  /** 科考 grade 区间 [min, max]（上沿高于研习，保证晋升大考更难一档） */
  examWindow: [number, number];
  /** 累计功名达此值解锁「本官阶的下一场科考」（布衣起点为 0） */
  expToReach: number;
  /** 高阶窗口冷门优先（加权，不改变可出卷集合） */
  preferCold?: boolean;
  /** 皇帝 Boss：名句 / 整首 / 高难 */
  isBoss?: boolean;
  /** 是否为皇帝 Boss（隐藏终点） */
  isEmperor?: boolean;
}

/**
 * 官途表（按 id 升序）。
 * grade 沿用 Poem.grade（1–12）。窗口随官阶整体上移；
 * 科考窗口上沿高于研习窗口上沿。
 */
export const RANKS: RankSpec[] = [
  { id: 0, key: "BUYI", label: "布衣", subtitle: "未入学的平民，识字读书的起点", difficulty: 1, gradeWindow: [1, 3], examWindow: [1, 4], expToReach: 0 },
  { id: 1, key: "TONGSHENG", label: "童生", subtitle: "县试初试，得入学宫", difficulty: 2, gradeWindow: [1, 4], examWindow: [2, 5], expToReach: 2000 },
  { id: 2, key: "XIUCAI", label: "秀才", subtitle: "府院试中式，得入士籍", difficulty: 3, gradeWindow: [2, 5], examWindow: [3, 6], expToReach: 5000 },
  { id: 3, key: "JUREN", label: "举人", subtitle: "乡试中举，「三十老诸生」", difficulty: 4, gradeWindow: [3, 7], examWindow: [4, 8], expToReach: 10000 },
  { id: 4, key: "GONGSHI", label: "贡士", subtitle: "会试中式，待殿试", difficulty: 5, gradeWindow: [5, 8], examWindow: [6, 9], expToReach: 18000 },
  { id: 5, key: "JINSHI", label: "进士", subtitle: "殿试金榜，「三十进士」", difficulty: 6, gradeWindow: [7, 9], examWindow: [7, 10], expToReach: 30000 },
  { id: 6, key: "HANLIN", label: "翰林", subtitle: "庶吉士散馆，入翰林院", difficulty: 7, gradeWindow: [8, 11], examWindow: [9, 11], expToReach: 48000, preferCold: true },
  { id: 7, key: "ZHIFU", label: "知府", subtitle: "出京外放，一府之尊", difficulty: 8, gradeWindow: [10, 12], examWindow: [10, 12], expToReach: 72000, preferCold: true },
  { id: 8, key: "SHILANG", label: "侍郎", subtitle: "入阁行走，二品大员", difficulty: 9, gradeWindow: [10, 12], examWindow: [11, 12], expToReach: 108000, preferCold: true },
  { id: 9, key: "CHENGXIANG", label: "丞相", subtitle: "入阁拜相，位极人臣", difficulty: 10, gradeWindow: [11, 12], examWindow: [12, 12], expToReach: 156000, preferCold: true },
  { id: 10, key: "DIWANG", label: "皇帝", subtitle: "登极大考，天子（隐藏 Boss）", difficulty: 11, gradeWindow: [12, 12], examWindow: [12, 12], expToReach: 0, isBoss: true, isEmperor: true, preferCold: true },
];

/** 皇帝官阶 id */
export const EMPEROR_RANK_ID = 10;
/** 普通官阶上限（丞相） */
export const MAX_NORMAL_RANK_ID = 9;
/** 官阶总数（含皇帝） */
export const RANK_COUNT = RANKS.length;

/** 官阶 id 是否合法（0..RANK_COUNT-1） */
export function isRankId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < RANK_COUNT;
}

/** 取官阶定义；id 越界抛 RangeError（纯逻辑，参数契约由调用方保证） */
export function rankById(id: number): RankSpec {
  if (!isRankId(id)) throw new RangeError(`未知官阶 id: ${id}`);
  const r = RANKS[id];
  if (!r) throw new RangeError(`未知官阶 id: ${id}`);
  return r;
}

/** 下一官阶；已是皇帝则返回 null（皇帝是终点，无下一阶） */
export function nextRank(id: number): RankSpec | null {
  rankById(id);
  if (id >= RANK_COUNT - 1) return null;
  return RANKS[id + 1];
}

/** 某官阶的下一场科考所需累计功名 */
export function expRequiredForNextExam(id: number): number {
  const next = nextRank(id);
  return next ? next.expToReach : 0;
}

/**
 * 功名达标判定：当前累计功名是否已解锁「rankId 对应的下一场科考」。
 * 布衣（id 0）的 expToReach = 0，恒为真（起点无门禁）。
 */
export function canTakeExam(currentRank: number, totalExp: number): boolean {
  if (!Number.isSafeInteger(totalExp) || totalExp < 0) return false;
  const next = nextRank(currentRank);
  if (!next) return false; // 已是皇帝，无科考
  return totalExp >= next.expToReach;
}

/**
 * 官阶出卷所需的题数（由 kind 决定）。
 * 每日题恒 1 题（先于皇帝判断，review A6：皇帝阶玩家开 DAILY 也 1 题，
 * 避免每天烧 15 个 g12 已见键、挤占登极大考池子）。
 */
export function countFor(rankId: number, kind: RankKind): number {
  if (kind === "DAILY") return DAILY_COUNT;
  const r = rankById(rankId);
  if (r.isEmperor) return EMPEROR_COUNT;
  if (kind === "EXAM") return EXAM_COUNT;
  return PRACTICE_COUNT;
}

/** 取该官阶该 kind 的 grade 窗口（科考用 examWindow，研习/每日用本官阶主窗口 gradeWindow） */
export function windowFor(rankId: number, kind: RankKind): [number, number] {
  const r = rankById(rankId);
  if (kind === "EXAM") return r.examWindow;
  return r.gradeWindow;
}

/** 该官阶是否启用冷门优先 */
export function preferColdFor(rankId: number): boolean {
  return !!rankById(rankId).preferCold;
}
