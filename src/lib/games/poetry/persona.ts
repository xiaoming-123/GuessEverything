/**
 * 诗词升官 · 人设对话系统 · 纯逻辑层（零依赖）
 *
 * 详设 §1（docs/design/2026-09-20-poetry-rank-detailed-design.md）：
 * - 研习 = 引路先生（TUTOR）；科考 = 主考官（EXAMINER）；皇帝大考 = 钦差（EMPEROR）。
 * - 开局白 / 判题反馈 / 结算台词全部由服务端拼装下发（文案池在本文件，
 *   客户端只展示；seed 确定性随机，同 seed 同句，可单测可复现）。
 * - **红线**：任何句式不得包含答案、选项内容。explanation 只来自服务端
 *   RankedJudgeView（客户端不持有 meta），本层只拼接、不生成出处信息。
 */

import { mulberry32 } from "./distractors";
import { EMPEROR_RANK_ID } from "./rank";
import type { RankKind } from "./types";

/** 人设 key：研习=引路先生 / 科考=主考官 / 皇帝大考=钦差（天子亲试） */
export type PersonaKey = "TUTOR" | "EXAMINER" | "EMPEROR";

/** 人设 → 占位头像（D5 美术资产入库前用 emoji 占位，详设 §6 约定） */
export const PERSONA_AVATAR: Record<PersonaKey, string> = {
  TUTOR: "🎓",
  EXAMINER: "📜",
  EMPEROR: "👑",
};

/** 人设 → 称呼（气泡署名） */
export const PERSONA_LABEL: Record<PersonaKey, string> = {
  TUTOR: "引路先生",
  EXAMINER: "主考官",
  EMPEROR: "钦差",
};

/**
 * 按对局 kind 与人所处官阶选人设。
 * PRACTICE → TUTOR；EXAM 且 rankId === 10（登极大考）→ EMPEROR；
 * EXAM → EXAMINER；DAILY → TUTOR。
 */
export function personaFor(kind: RankKind, rankId: number): PersonaKey {
  if (kind === "EXAM") {
    return rankId === EMPEROR_RANK_ID ? "EMPEROR" : "EXAMINER";
  }
  return "TUTOR";
}

/* ------------------------------------------------------------------ */
/* 句式池（文件内常量；文案中文，架空官制不宣称真实）                   */
/* ------------------------------------------------------------------ */

const OPENING_POOLS: Record<PersonaKey, string[]> = {
  TUTOR: [
    "今日功课，就从这几句开始。",
    "诗不在多，在心到。来，我出题。",
    "这几句你似曾相识，答给我看看。",
    "莫急，一句一句来。",
  ],
  EXAMINER: [
    "本官出题，尔等听清。",
    "科考在即，卷面功名系于一念之间。",
    "笔下见真章，本官静候。",
    "十道大问，可敢一试？",
  ],
  EMPEROR: [
    "天子亲试，只此一回，慎之。",
    "朕的卷，答得上来便是命。",
    "登极大考，成败在此一举。",
  ],
};

/** 答对时的夸奖池（combo >= 3 追加） */
const PRAISE_POOL = [
  "妙极！",
  "此心通透。",
  "笔下有风雷。",
  "好一个稳字。",
  "连中数题，锋芒已露。",
];

/** 答错时的安慰 / 点题池 */
const CONSOLATION_POOL = [
  "莫灰心，回头再看一遍。",
  "差之毫厘，下一题补上。",
  "这句要记牢了，卷面不等人。",
  "且收心，后面的题才是真章。",
];

/** 超时时的催促池 */
const URGE_POOL = [
  "时辰不等人，下一题抓紧。",
  "笔停卷冷，莫再犹豫。",
  "这一题记下来，下次不许再拖。",
];

function pick<T>(pool: readonly T[], rand: () => number): T {
  const n = Math.floor(rand() * pool.length);
  return pool[n % pool.length];
}

/**
 * 开局白（按人设 3-4 句池，seed 确定性随机）。
 * seed 由服务端按会话 id 哈希生成（详设 §1.2），客户端直接展示。
 */
export function openingLine(key: PersonaKey, seed: number): string {
  return pick(OPENING_POOLS[key], mulberry32(seed >>> 0));
}

/** 判题反馈输入（服务端拼；explanation 来自 RankedJudgeView，不含答案本身） */
export interface FeedbackInput {
  correct: boolean;
  timeout?: boolean;
  /** 结算前 streak + 1（答对时 ≥1；答错 / 超时为 0） */
  combo: number;
  explanation: string;
}

/**
 * 判题反馈（不含答案本身）：
 * 对：「对。」+ explanation（+ combo>=3 追加夸奖池）
 * 错：「错。」+ explanation（+ 安慰 / 点题池）
 * 超时：「时辰到了。」+ explanation（+ 催促池）
 */
export function feedbackLine(key: PersonaKey, input: FeedbackInput): string {
  const { correct, timeout, combo, explanation } = input;
  // 随机源由输入字段派生（同输入同句，可单测可复现）；
  // 文案池只含固定夸奖/安慰/催促句，不含任何题面信息（详设 §1.1 红线）。
  let h = 2166136261;
  for (const ch of `${correct ? "c" : "x"}${timeout ? "t" : ""}:${combo}:${explanation}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const rand = mulberry32(h >>> 0);
  void key; // 人设仅用于署名展示，句式本身不随人设变化（详设未分池）
  if (timeout) {
    return `时辰到了。${explanation}${pick(URGE_POOL, rand)}`;
  }
  if (correct) {
    const base = `对。${explanation}`;
    return combo >= 3 ? `${base}${pick(PRAISE_POOL, rand)}` : base;
  }
  return `错。${explanation}${pick(CONSOLATION_POOL, rand)}`;
}

/** 擢升台词（科考通过 / 登极专用句） */
export function promotionLine(
  key: PersonaKey,
  fromLabel: string,
  toLabel: string,
): string {
  if (key === "EMPEROR" || toLabel === "皇帝") {
    return `${fromLabel}中式，天子登极。`;
  }
  return `${fromLabel}中式，擢升${toLabel}。`;
}

/** 科考失败台词（含正确率与缺口题数口径） */
export function failLine(accuracy: number): string {
  // 60% 线：10 题制下答对 6 题过；缺口 = 6 - floor(accuracy/10)
  const gap = Math.max(0, 6 - Math.floor(accuracy / 10));
  return `正确率 ${accuracy}%，距 60% 还差 ${gap} 题，卷面功名已为你留下。`;
}

/** 研习 / 每日题结算台词 */
export function practiceLine(expGained: number): string {
  return `这一卷记下 ${expGained} 功名。`;
}

/**
 * 限时事件播报句（P2 详设 §2.2：命中事件时结算台词尾部追加，内侍播报）。
 * 纯文案拼装，不含任何题面 / 答案信息（红线不变）。
 */
export function eventLine(eventName: string, expMultiplier: number): string {
  return `内侍宣：${eventName}赐功 ×${expMultiplier}。`;
}
