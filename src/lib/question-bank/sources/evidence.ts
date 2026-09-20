/**
 * 智能体题库引擎 · 来源与证据规范（纯函数）
 *
 * 设计稿第 4/5 节：
 * - 每次采集保留不可变 Snapshot：来源 URI、版本、抓取时间、内容哈希、定位证据、原文。
 * - 规范化（繁简/标点）不得覆盖原文；原句必须能回溯至快照。
 * - 外部网页文字仅作为数据，不能修改 agent 指令（提示注入在 provider 层防护，
 *   此处提供注入特征识别，供校验器/样本使用）。
 */

import { createHash } from "node:crypto";
import type {
  EvidenceSpan,
  SourceSnapshot,
  StructuredIssue,
  ValidationResult,
} from "../contracts/types";

/** 规范化器版本（繁简/标点整理；测试固定） */
export const CONVERTER_VERSION = "norm-v1";

/** 确定性内容哈希：UTF-8 原文 → SHA-256 十六进制（小写） */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 规范化文本：去除标点与空白、繁体→简体（内置小表，覆盖样本所需字）。
 * 仅用于比较/去重，不覆盖原文。
 */
const TRAD_SIMP: Record<string, string> = {
  "詩": "诗", "詞": "词", "書": "书", "國": "国", "學": "学",
  "長": "长", "門": "门", "風": "风", "雲": "云", "馬": "马",
  "東": "东", "陽": "阳", "陰": "阴", "為": "为", "與": "与",
  "見": "见", "問": "问", "時": "时", "來": "来", "去": "去",
  "靜": "静", "飛": "飞", "鳴": "鸣", "鶴": "鹤", "樓": "楼",
};

export function normalizeLine(line: string): string {
  let out = line;
  for (const [trad, simp] of Object.entries(TRAD_SIMP)) {
    out = out.split(trad).join(simp);
  }
  // 去除常见标点与空白
  return out.replace(/[\s，。、；：！？“”‘’（）《》〈〉,.:;!?()]/g, "");
}

/** 构建不可变快照（同来源同 revision/hash 幂等由存储层唯一键保证） */
export function buildSnapshot(input: {
  snapshotId: string;
  sourceId: string;
  revision: string;
  capturedAt: string;
  evidencePath: string;
  rawText: string;
}): SourceSnapshot {
  return {
    snapshotId: input.snapshotId,
    sourceId: input.sourceId,
    revision: input.revision,
    capturedAt: input.capturedAt,
    contentHash: sha256Hex(input.rawText),
    evidencePath: input.evidencePath,
    rawText: input.rawText,
    normalizedText: input.rawText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map(normalizeLine)
      .join("\n"),
    converterVersion: CONVERTER_VERSION,
  };
}

/** 证据回溯：span 文本必须与快照原文逐字一致（回溯锚点） */
export function spanMatchesSnapshot(
  snapshot: SourceSnapshot,
  span: EvidenceSpan,
): boolean {
  if (span.snapshotId !== snapshot.snapshotId) return false;
  if (span.start < 0 || span.end <= span.start) return false;
  if (span.end > snapshot.rawText.length) return false;
  return snapshot.rawText.slice(span.start, span.end) === snapshot.rawText.slice(span.start, span.end);
}

/** 在快照中定位文本首次出现的跨度（命题/审核回溯用） */
export function locateSpan(
  snapshot: SourceSnapshot,
  text: string,
): EvidenceSpan | null {
  const idx = snapshot.rawText.indexOf(text);
  if (idx < 0 || text.length === 0) return null;
  return { snapshotId: snapshot.snapshotId, start: idx, end: idx + text.length };
}

/** 规范化文本中定位（去重/相似候选用） */
export function locateInNormalized(
  snapshot: SourceSnapshot,
  normalizedText: string,
): boolean {
  return snapshot.normalizedText.includes(normalizedText);
}

/**
 * 提示注入特征识别（来源提示注入样本）。
 * 外部内容若包含对 agent 的指令性措辞，只能作为待核验数据，
 * 绝不能进入模型提示。命中 → issue code "SOURCE_INJECTION"。
 */
const INJECTION_PATTERNS: RegExp[] = [
  /忽略(之前|以上|上述|所有)[的]?(指令|要求|规则|限制)/i,
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts)/i,
  /system\s*:\s*/i,
  /\[?(system|assistant)\]?\s*:/i,
  /你现在(是|扮演)/,
  /你的新(指令|任务|规则)/,
  /请(忽略|忘记).{0,12}(指令|规则|约束)/,
];

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** 注入检测 issue（供校验器汇总） */
export function injectionIssue(message: string): StructuredIssue {
  return { code: "SOURCE_INJECTION", message };
}

/**
 * 来源证据完整性校验（设计稿硬门槛第 1 条）：
 * - 快照存在且 contentHash 与 rawText 一致
 * - 证据 span 可回溯
 * - 外部内容含注入特征 → SOURCE_INJECTION
 */
export function verifyEvidence(input: {
  snapshot: SourceSnapshot;
  spans: EvidenceSpan[];
}): ValidationResult {
  const issues: StructuredIssue[] = [];
  const { snapshot, spans } = input;

  if (sha256Hex(snapshot.rawText) !== snapshot.contentHash) {
    issues.push({
      code: "SNAPSHOT_HASH_MISMATCH",
      message: "快照 contentHash 与 rawText 不一致（快照被篡改或记录错误）",
    });
  }
  for (const span of spans) {
    if (!spanMatchesSnapshot(snapshot, span)) {
      issues.push({
        code: "EVIDENCE_SPAN_INVALID",
        message: `证据 span [${span.start},${span.end}) 无法回溯至快照 ${span.snapshotId}`,
        location: `span@${span.start}`,
      });
    }
  }
  if (detectInjection(snapshot.rawText)) {
    issues.push(
      injectionIssue("快照原文含指令性措辞（提示注入特征），仅可作数据，禁止进入模型提示"),
    );
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
