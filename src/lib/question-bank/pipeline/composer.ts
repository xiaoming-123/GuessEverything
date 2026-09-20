/**
 * 智能体题库引擎 · 模板命题器（P1，确定性执行器，非模型）
 *
 * 设计稿第 3 节：「三种现有题型优先用模板从原文抽取答案；模型主要提出
 * 干扰项、难度和解释。」P1 阶段命题为纯模板执行器（零模型、零随机源
 * 之外的 IO），模型（模拟 provider）只参与干扰项重取与审核。
 *
 * 产出：
 * - QuestionVersion（v1，status=DRAFT，contentHash 由 rules.questionContentHash 计算）
 * - 证据映射（promptSpan / answerSpan 可回溯至快照）
 * - 干扰项池（供修订器重取，按题型过滤合规项）
 *
 * 题目身份（设计稿第 5 节）：
 * - questionId 由「知识点」派生：题型 + 作品版本 + 题干句（规范化），
 *   换措辞/选项/难度不改变 questionId 的输入即不产生新知识点 ID；
 *   但换题干句/换作品 → 新知识点。
 */

import { locateSpan, normalizeLine, sha256Hex } from "../sources/evidence";
import { questionContentHash } from "../validators/rules";
import type {
  QuestionType,
  QuestionVersion,
  Rand,
  SourceSnapshot,
  StructuredIssue,
  Work,
  WorkVersion,
} from "../contracts/types";

/** 题目知识点的稳定身份（题型 + 作品版本 + 规范题干句） */
export function questionIdentityKey(
  type: QuestionType,
  workVersionId: string,
  promptLine: string,
): string {
  return sha256Hex(`${type}|${workVersionId}|${normalizeLine(promptLine)}`);
}

/** 选项排序（确定性：按 seed 洗牌，保证可复现） */
function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 选项是否为诗行特征（与 rules 保持一致） */
function isLineish(s: string): boolean {
  return /[，。！？]/.test(s) || s.replace(/[\s，。！？]/g, "").length >= 5;
}

export interface ComposeInput {
  type: QuestionType;
  work: Work;
  workVersion: WorkVersion;
  snapshot: SourceSnapshot;
  /** 干扰项候选池（已按题型过滤的合规项；命题器从中选取） */
  distractorPool: string[];
  /** 确定性种子（复现用） */
  seed: number;
}

export interface ComposeResult {
  ok: boolean;
  version: QuestionVersion | null;
  /** 干扰项池（修订重取用；已按题型过滤并去重） */
  distractorPool: string[];
  issues: StructuredIssue[];
}

/**
 * 模板命题。题干句按规则选取：
 * - GUESS_POET / GUESS_TITLE：取作品最后一联（前句，避免末句直接暗示诗名/作者）；
 *   名句拼接支持两联（prompt = 句 a + "，" + 句 b）。
 * - COMPLETE_NEXT：取中间某句，答案 = 下一句（末句不可作题干）。
 */
export function composeQuestion(input: ComposeInput): ComposeResult {
  const issues: StructuredIssue[] = [];
  const { type, workVersion, snapshot, distractorPool, seed } = input;
  const lines = workVersion.lines;

  if (lines.length < 2) {
    return {
      ok: false,
      version: null,
      distractorPool: [],
      issues: [{ code: "WORK_TOO_SHORT", message: `作品不足 2 句，无法命题（实际 ${lines.length}）` }],
    };
  }

  // 干扰项合规过滤（按题型）
  let pool = [...new Set(distractorPool)].filter(
    (s) => s && !lines.includes(s),
  );
  if (type === "GUESS_POET" || type === "GUESS_TITLE") {
    pool = pool.filter((s) => !isLineish(s));
  }
  if (type === "COMPLETE_NEXT") {
    pool = pool.filter((s) => lines.includes(s) || isLineish(s));
  }

  let prompt = "";
  let correct = "";
  switch (type) {
    case "GUESS_POET": {
      // 取倒数第二句（末句留作答案锚点之外的证据；作者来自 workVersion）
      prompt = lines[lines.length - 2];
      correct = workVersion.author;
      if (pool.includes(correct)) pool = pool.filter((s) => s !== correct);
      break;
    }
    case "GUESS_TITLE": {
      prompt = lines[lines.length - 2];
      correct = workVersion.title;
      if (pool.includes(correct)) pool = pool.filter((s) => s !== correct);
      break;
    }
    case "COMPLETE_NEXT": {
      // 取中间句（避免首句无上下文、末句无下句）；多行时取正中间
      const idx = Math.floor((lines.length - 1) / 2);
      prompt = lines[idx];
      correct = lines[idx + 1];
      break;
    }
  }

  const promptSpan = locateSpan(snapshot, prompt);
  if (!promptSpan) {
    issues.push({
      code: "PROMPT_NOT_IN_SNAPSHOT",
      message: `题干句「${prompt}」无法在快照中定位`,
    });
  }
  const answerSpan = locateSpan(snapshot, correct);
  if (!answerSpan) {
    issues.push({
      code: "ANSWER_NOT_IN_SNAPSHOT",
      message: `答案「${correct}」无法在快照中定位`,
    });
  }

  // 组四选项：正确项 + 3 个干扰项（确定性洗牌）
  const options = [correct, ...shuffled(pool, seed).slice(0, 3)];
  if (options.length < 4) {
    issues.push({
      code: "INSUFFICIENT_DISTRACTORS",
      message: `干扰项不足：需 3，实际 ${pool.length}（池 ${pool.length}）`,
    });
  }

  if (issues.length > 0) {
    return { ok: false, version: null, distractorPool: pool, issues };
  }

  const questionId = questionIdentityKey(type, workVersion.workVersionId, prompt);
  const version: QuestionVersion = {
    questionId,
    version: 1,
    type,
    prompt,
    options: options as [string, string, string, string],
    correctOptionId: options[0],
    evidence: {
      promptSpan: promptSpan!,
      answerSpan: answerSpan!,
    },
    workVersionId: workVersion.workVersionId,
    contentHash: "",
    status: "DRAFT",
  };
  version.contentHash = questionContentHash(version);

  return { ok: true, version, distractorPool: pool, issues: [] };
}
