/**
 * 智能体题库引擎 · 规则校验器（确定性程序，非模型）
 *
 * 设计稿第 7 节硬门槛（模型投票不可覆盖）：
 *  1. 来源已启用、快照可追溯、正文/作者/标题与版本证据一致
 *  2. 四选项规范化后唯一、类型一致、非空；正确 optionId 恰好对应一个选项
 *  3. 正确答案由核验原文 + 模板计算；独立作答一致；别名/多解 → 拒绝或消歧
 *  4. 题干不泄露答案；玩家可见字段白名单
 *  5. 重复知识点合并；同题面去重（含 faceKey 维度）
 *  6. 难度建议合法
 *
 * 异文 / 别名 / 多答案 / 重复 / 答案泄漏 / 来源注入各有独立 issue code，
 * 供固定样本集验收。
 */

import {
  normalizeLine,
  sha256Hex,
  spanMatchesSnapshot,
  verifyEvidence,
} from "../sources/evidence";
import type {
  QuestionType,
  QuestionVersion,
  SourceEntry,
  SourceSnapshot,
  StructuredIssue,
  ValidationResult,
  Work,
  WorkVersion,
} from "../contracts/types";

export const RULE_VALIDATOR_VERSION = "rules-v1";

/** 题型 → 玩家可见字段白名单（答案保密：猜作者/诗名不得下发 poet/poemTitle 元数据） */
export const PLAYER_VISIBLE_FIELDS: Record<
  QuestionType,
  { prompt: string; options: string }
> = {
  GUESS_POET: { prompt: "题干", options: "诗人姓名选项" },
  GUESS_TITLE: { prompt: "题干", options: "诗名选项" },
  COMPLETE_NEXT: { prompt: "上句", options: "下句选项" },
};

/** 候选题版本的内容哈希（题型+题干+选项+答案+证据，确定性） */
export function questionContentHash(v: QuestionVersion): string {
  const canon = [
    v.type,
    v.prompt,
    v.options.join("|"),
    v.correctOptionId,
    v.workVersionId,
    `${v.evidence.promptSpan.start}:${v.evidence.promptSpan.end}`,
    `${v.evidence.answerSpan.start}:${v.evidence.answerSpan.end}`,
  ].join("\n");
  return sha256Hex(canon);
}

/** 题面指纹（跨版本去重：题型+规范题干+规范正确答案，不含版本/选项顺序） */
export function faceFingerprint(type: QuestionType, prompt: string, correct: string): string {
  return sha256Hex(`${type}|${normalizeLine(prompt)}|${normalizeLine(correct)}`);
}

/** 正确答案值（按 correctOptionId 反查选项） */
export function correctOptionValue(v: QuestionVersion): string | null {
  const i = v.options.indexOf(v.correctOptionId);
  return i >= 0 ? v.options[i] : null;
}

/**
 * 选项类型一致性：四个选项必须属于同一「实体类别」。
 * 猜诗人 → 均为人名（非诗行）；猜诗名 → 均为题名；补下句 → 均为诗句。
 * 模拟判定：正确项与所有干扰项不得互相混入（如诗人选项里混入诗句）。
 */
function checkOptionHomogeneity(
  type: QuestionType,
  options: string[],
  issues: StructuredIssue[],
): void {
  const nonEmpty = options.filter((o) => o.trim().length > 0);
  if (nonEmpty.length !== 4) {
    issues.push({ code: "OPTION_EMPTY", message: "选项存在空值" });
    return;
  }
  // 类型一致性：诗句选项不含标点（标点在句中），故按「诗行长度特征」判定混排
  const isPoeticLine = (s: string) =>
    /[，。！？]/.test(s) || s.replace(/[\s，。！？]/g, "").length >= 5;
  const poeticCount = nonEmpty.filter(isPoeticLine).length;
  if (type === "GUESS_POET" && poeticCount > 0) {
    issues.push({
      code: "OPTION_TYPE_MISMATCH",
      message: `猜诗人选项混入诗句（${poeticCount} 个为诗行而非人名）`,
    });
  }
  if (type === "GUESS_TITLE") {
    // 题名不含诗句标点；题名本身可长于 4 字，故不用诗行长度特征
    const bad = nonEmpty.filter((s) => /[，。！？]/.test(s));
    if (bad.length > 0) {
      issues.push({
        code: "OPTION_TYPE_MISMATCH",
        message: `猜诗名选项混入诗句（${bad.length} 个含诗句标点）`,
      });
    }
  }
  if (type === "COMPLETE_NEXT" && poeticCount === 0) {
    issues.push({
      code: "OPTION_TYPE_MISMATCH",
      message: "补下句选项应为诗句（均未呈诗行特征，疑似人名/题名混入）",
    });
  }
}

/** 题干泄露检查：题干（含题前解释）不得包含正确答案文本 */
function checkAnswerLeak(
  v: QuestionVersion,
  correct: string,
  issues: StructuredIssue[],
): void {
  if (v.prompt.includes(correct)) {
    issues.push({
      code: "ANSWER_LEAK",
      message: "题干包含正确答案文本（答案泄漏）",
      location: "prompt",
    });
  }
  // 补下句：题干（上句）不得等于/包含下句
  if (v.type === "COMPLETE_NEXT" && normalizeLine(v.prompt) === normalizeLine(correct)) {
    issues.push({
      code: "ANSWER_LEAK",
      message: "补下句题干与答案规范化后相同",
      location: "prompt",
    });
  }
}

/**
 * 完整规则校验（硬门槛）。
 * 返回全部 issue（硬失败不被模型投票覆盖）。
 */
export function validateCandidate(input: {
  source: SourceEntry;
  snapshot: SourceSnapshot;
  work: Work;
  workVersion: WorkVersion;
  version: QuestionVersion;
  /** 已发布的同题面指纹（跨批次去重） */
  existingFaceFingerprints?: Set<string>;
  /** 已发布的 questionId → 最高版本（知识点去重） */
  existingQuestionIds?: Map<string, number>;
}): ValidationResult {
  const issues: StructuredIssue[] = [];
  const { source, snapshot, work, workVersion, version } = input;

  /* 1. 来源与证据 */
  if (!source.enabled) {
    issues.push({ code: "SOURCE_DISABLED", message: `来源 ${source.sourceId} 未启用` });
  }
  if (snapshot.sourceId !== source.sourceId) {
    issues.push({ code: "SNAPSHOT_SOURCE_MISMATCH", message: "快照来源与来源注册表不一致" });
  }
  const ev = verifyEvidence({ snapshot, spans: [version.evidence.promptSpan, version.evidence.answerSpan] });
  if (!ev.ok) issues.push(...ev.issues);

  /* 2. 作品版本与快照一致（按行回溯；标点/分行差异不影响单句定位） */
  const missingLines = workVersion.lines.filter((l) => !snapshot.rawText.includes(l));
  if (missingLines.length > 0) {
    issues.push({
      code: "WORK_NOT_IN_SNAPSHOT",
      message: `作品版本正文有 ${missingLines.length} 句无法在快照原文中定位（正文/作者/标题与证据不一致）`,
      location: missingLines.join(" / "),
    });
  }
  if (work.verificationStatus !== "VERIFIED") {
    issues.push({
      code: "WORK_UNVERIFIED",
      message: `作品 ${work.workId} 核验状态为 ${work.verificationStatus}，须 VERIFIED 才可命题`,
    });
  }
  if (workVersion.workId !== work.workId) {
    issues.push({ code: "WORK_VERSION_MISMATCH", message: "作品版本与作品身份不匹配" });
  }

  /* 2b. 选项结构 */
  if (version.options.length !== 4) {
    issues.push({ code: "OPTION_COUNT", message: `选项数应为 4，实际 ${version.options.length}` });
  }
  if (new Set(version.options).size !== version.options.length) {
    issues.push({ code: "DUPLICATE_OPTION", message: "选项规范化前即存在重复" });
  }
  const normOptions = version.options.map(normalizeLine);
  if (new Set(normOptions).size !== version.options.length) {
    issues.push({
      code: "DUPLICATE_OPTION_NORM",
      message: "选项规范化后重复（繁简/标点差异伪装的不同选项）",
    });
  }
  checkOptionHomogeneity(version.type, version.options, issues);

  /* 2c. 正确 optionId 恰好对应一个选项 */
  const correct = correctOptionValue(version);
  if (correct === null) {
    issues.push({ code: "CORRECT_OPTION_MISSING", message: "correctOptionId 未对应任何选项" });
  } else {
    if (version.options.filter((o) => o === correct).length !== 1) {
      issues.push({ code: "CORRECT_OPTION_AMBIGUOUS", message: "正确 optionId 对应多个选项" });
    }
    checkAnswerLeak(version, correct, issues);

    /* 3. 答案与核验原文一致（模板计算） */
    const tplAnswer = templateAnswer(version.type, snapshot, workVersion, version.evidence.promptSpan);
    if (tplAnswer !== null && normalizeLine(tplAnswer) !== normalizeLine(correct)) {
      issues.push({
        code: "ANSWER_MISMATCH",
        message: `正确答案 ${correct} 与核验原文模板计算结果 ${tplAnswer} 不一致`,
      });
    }

    /* 3b. 多解检查：选项里存在另一个与正确答案「规范化相同」的值 → 多答案 */
    const normCorrect = normalizeLine(correct);
    const dupAnswers = version.options.filter(
      (o) => normalizeLine(o) === normCorrect && o !== correct,
    );
    if (dupAnswers.length > 0) {
      issues.push({
        code: "MULTI_ANSWER",
        message: `存在多解：选项 ${dupAnswers.join(",")} 与正确答案规范化相同`,
      });
    }

    /* 3c. 别名冲突：正确选项是作者的别名（非规范名）→ 需登记消歧 */
    if (version.type === "GUESS_POET") {
      if (correct !== work.authorCanonical && work.authorAliases.includes(correct)) {
        issues.push({
          code: "ALIAS_CONFLICT",
          message: `正确选项 ${correct} 是作者别名（规范名 ${work.authorCanonical}），须补足消歧或改用规范名`,
        });
      }
    }
    if (version.type === "GUESS_TITLE") {
      if (correct !== work.titleCanonical && work.titleAliases.includes(correct)) {
        issues.push({
          code: "ALIAS_CONFLICT",
          message: `正确选项 ${correct} 是标题别名（规范名 ${work.titleCanonical}），须补足消歧或改用规范名`,
        });
      }
    }
  }

  /* 4. 玩家可见白名单（答案保密） */
  if (version.type === "GUESS_POET") {
    // 题干不得包含作者名（含别名）
    const names = [work.authorCanonical, ...work.authorAliases];
    for (const n of names) {
      if (n && version.prompt.includes(n)) {
        issues.push({
          code: "ANSWER_LEAK",
          message: `猜诗人题干包含作者名 ${n}（含别名即泄漏）`,
          location: "prompt",
        });
      }
    }
  }
  if (version.type === "GUESS_TITLE") {
    const titles = [work.titleCanonical, ...work.titleAliases];
    for (const t of titles) {
      if (t && version.prompt.includes(t)) {
        issues.push({
          code: "ANSWER_LEAK",
          message: `猜诗名题干包含诗名 ${t}（含别名即泄漏）`,
          location: "prompt",
        });
      }
    }
  }

  /* 5. 去重：知识点 / 题面 */
  if (input.existingQuestionIds) {
    const prev = input.existingQuestionIds.get(version.questionId);
    if (prev !== undefined && prev >= version.version) {
      issues.push({
        code: "DUPLICATE_QUESTION_ID",
        message: `知识点 ${version.questionId} 已存在版本 v${prev}，不得覆盖`,
      });
    }
  }
  if (input.existingFaceFingerprints && correct !== null) {
    const fp = faceFingerprint(version.type, version.prompt, correct);
    if (input.existingFaceFingerprints.has(fp)) {
      issues.push({
        code: "DUPLICATE_FACE",
        message: "同题面已发布（含换 ID/换选项顺序的换皮题），须合并版本",
      });
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * 模板答案计算（命题 agent 的答案来源；审核 agent 独立作答的对照基准）。
 * 仅由「核验原文 + 证据跨度 + 题型」推导，不依赖命题者声明。
 */
export function templateAnswer(
  type: QuestionType,
  snapshot: SourceSnapshot,
  workVersion: WorkVersion,
  promptSpan: { snapshotId: string; start: number; end: number },
): string | null {
  if (!spanMatchesSnapshot(snapshot, promptSpan)) return null;
  const promptText = snapshot.rawText.slice(promptSpan.start, promptSpan.end);
  const lines = workVersion.lines;

  switch (type) {
    case "GUESS_POET":
      // 名句必须出自该作品版本
      if (!lines.some((l) => promptText.includes(l) || l.includes(promptText))) {
        // 允许两联拼接（名句 = 句 a + 句 b）
        const joined = lines.some((l) => promptText === l) ||
          lines.some((l, i) => i + 1 < lines.length && promptText === `${l}，${lines[i + 1]}`);
        if (!joined) return null;
      }
      return workVersion.author;
    case "GUESS_TITLE":
      if (!lines.some((l) => promptText === l || promptText.includes(l))) return null;
      return workVersion.title;
    case "COMPLETE_NEXT": {
      const idx = lines.findIndex((l) => l === promptText);
      if (idx < 0 || idx + 1 >= lines.length) return null;
      return lines[idx + 1];
    }
  }
}

/** 证据跨度文本（审计/展示用） */
export function spanText(snapshot: SourceSnapshot, span: { snapshotId: string; start: number; end: number }): string {
  return snapshot.rawText.slice(span.start, span.end);
}

/** 相似度初筛（语义近似题进入复核的入口；非判定） */
export function similarityScore(a: string, b: string): number {
  const na = normalizeLine(a);
  const nb = normalizeLine(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // 字符重合率（Jaccard 近似）
  const sa = new Set(na);
  const sb = new Set(nb);
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 语义近似阈值：超过 → 进入复核（QUARANTINED 待核验），不自动放行 */
export const SIMILARITY_REVIEW_THRESHOLD = 0.85;
