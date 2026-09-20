/**
 * P0 固定样本验收（可复现，不依赖网络/模型）
 *
 * 覆盖：歧义、多答案、作者别名、重复题、答案泄露、提示词注入、异文、正确。
 * 每条样本：build() 装配事实集 → validateCandidate 断言期望 issue code 集合。
 */

import { describe, expect, it } from "vitest";
import {
  FIXED_SAMPLES,
  EXPECTED_TAGS,
} from "@/lib/question-bank/samples/fixed";
import {
  faceFingerprint,
  validateCandidate,
} from "@/lib/question-bank/validators/rules";
import { correctOptionValue } from "@/lib/question-bank/validators/rules";

function runSample(sample: (typeof FIXED_SAMPLES)[number]) {
  const { source, work, workVersion, version, snapshot } = sample.build();

  let existingFaceFingerprints: Set<string> | undefined;
  let existingQuestionIds: Map<string, number> | undefined;
  if (sample.dedupContext?.sameFace) {
    const correct = correctOptionValue(version) ?? "";
    existingFaceFingerprints = new Set([
      faceFingerprint(version.type, version.prompt, correct),
    ]);
  }
  if (sample.dedupContext?.questionIdMaxVersion !== undefined) {
    existingQuestionIds = new Map([
      [version.questionId, sample.dedupContext.questionIdMaxVersion],
    ]);
  }

  const result = validateCandidate({
    source,
    snapshot,
    work,
    workVersion,
    version,
    existingFaceFingerprints,
    existingQuestionIds,
  });
  return { result, sample };
}

describe("P0 固定样本集", () => {
  it("样本集维度完整：每个验收标签至少一条样本", () => {
    const tags = new Set(FIXED_SAMPLES.flatMap((s) => s.tags));
    const required = new Set(EXPECTED_TAGS.map((t) => t.tag));
    for (const t of required) {
      expect(tags.has(t), `缺少验收维度 ${t}`).toBe(true);
    }
    // 样本 id 与标签映射一致
    for (const { sampleId, tag } of EXPECTED_TAGS) {
      const s = FIXED_SAMPLES.find((x) => x.sampleId === sampleId);
      expect(s, `样本不存在 ${sampleId}`).toBeTruthy();
      expect(s!.tags).toContain(tag);
    }
  });

  for (const sample of FIXED_SAMPLES) {
    it(`${sample.sampleId}（${sample.tags.join("/")}）: ${sample.description}`, () => {
      const { result } = runSample(sample);
      expect(result.ok).toBe(sample.expect.ok);
      const got = new Set(result.ok ? [] : result.issues.map((i) => i.code));
      for (const code of sample.expect.issueCodes) {
        expect(got.has(code), `应发现 ${code}，实际: ${[...got].join(",") || "(无)"}`).toBe(
          true,
        );
      }
    });
  }

  it("正确样本：三个题型（猜诗人/猜诗名/补下句）均一次通过", () => {
    const correct = FIXED_SAMPLES.filter((s) => s.tags.includes("CORRECT"));
    expect(correct).toHaveLength(3);
    for (const s of correct) {
      const { result } = runSample(s);
      expect(result.ok, `${s.sampleId}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("歧义样本：正确 optionId 对应两个相同选项 → CORRECT_OPTION_AMBIGUOUS", () => {
    const s = FIXED_SAMPLES.find((x) => x.sampleId === "fs-ambiguous-correct-option")!;
    const { result } = runSample(s);
    expect(result.ok).toBe(false);
    const codes = new Set((result.ok ? [] : result.issues).map((i) => i.code));
    expect(codes.has("CORRECT_OPTION_AMBIGUOUS")).toBe(true);
    expect(codes.has("DUPLICATE_OPTION")).toBe(true);
  });

  it("重复题样本：同题面（换选项顺序）→ DUPLICATE_FACE，且不含误报", () => {
    const s = FIXED_SAMPLES.find((x) => x.sampleId === "fs-duplicate")!;
    const { result } = runSample(s);
    expect(result.ok).toBe(false);
    const codes = new Set((result.ok ? [] : result.issues).map((i) => i.code));
    expect(codes.has("DUPLICATE_FACE")).toBe(true);
    expect(codes.has("DUPLICATE_QUESTION_ID")).toBe(false);
    expect(codes.has("ANSWER_LEAK")).toBe(false);
  });
});
