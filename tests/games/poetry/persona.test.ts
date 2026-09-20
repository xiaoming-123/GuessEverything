/**
 * D1 · 人设对话系统单测（详设 §1 / §7 D1）
 *
 * 验收项：
 * - 同 seed 同句（确定性，可复现）
 * - 红线断言：判前视图（start/resume 下发的 rounds）不含 answerIndex / 正确选项序
 *   （构造 100 个 round 断言 toRoundView 输出无泄漏；review B1 口径）
 * - feedbackLine 不含未作答轮的答案信息
 * - personaFor 映射（DAILY→TUTOR / EXAM+10→EMPEROR / EXAM→EXAMINER / PRACTICE→TUTOR）
 */
import { describe, expect, it } from "vitest";
import {
  feedbackLine,
  openingLine,
  personaFor,
  promotionLine,
  failLine,
  practiceLine,
  type PersonaKey,
} from "@/lib/games/poetry/persona";
import { materializeRound, pickQuote } from "@/lib/games/poetry/engine";
import { mulberry32 } from "@/lib/games/poetry/distractors";
import { PoetryQuestionType, toRoundView, type PoemCorpusItem, type PoetryRound } from "@/lib/games/poetry/types";

/* ------------------------------------------------------------------ */
/* 测试语料（公版，内联构造，不依赖种子文件）                            */
/* ------------------------------------------------------------------ */

const corpus: PoemCorpusItem[] = [
  {
    id: "p1",
    title: "静夜思",
    poet: "李白",
    dynasty: "唐",
    grade: 1,
    lines: ["床前明月光", "疑是地上霜", "举头望明月", "低头思故乡"],
    famous: true,
  },
  {
    id: "p2",
    title: "春晓",
    poet: "孟浩然",
    dynasty: "唐",
    grade: 1,
    lines: ["春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少"],
    famous: true,
  },
];

/* ------------------------------------------------------------------ */
/* personaFor 映射                                                     */
/* ------------------------------------------------------------------ */

describe("personaFor 人设映射", () => {
  it("PRACTICE → TUTOR", () => {
    expect(personaFor("PRACTICE", 0)).toBe("TUTOR");
    expect(personaFor("PRACTICE", 5)).toBe("TUTOR");
  });

  it("DAILY → TUTOR", () => {
    expect(personaFor("DAILY", 0)).toBe("TUTOR");
    expect(personaFor("DAILY", 10)).toBe("TUTOR");
  });

  it("EXAM → EXAMINER（普通官阶）", () => {
    expect(personaFor("EXAM", 0)).toBe("EXAMINER");
    expect(personaFor("EXAM", 9)).toBe("EXAMINER");
  });

  it("EXAM + rankId 10 → EMPEROR（登极大考）", () => {
    expect(personaFor("EXAM", 10)).toBe("EMPEROR");
  });
});

/* ------------------------------------------------------------------ */
/* openingLine：同 seed 同句（确定性）                                  */
/* ------------------------------------------------------------------ */

describe("openingLine 开局白", () => {
  it("同 seed 同句（三个池 × 多 seed 全部确定性）", () => {
    const keys: PersonaKey[] = ["TUTOR", "EXAMINER", "EMPEROR"];
    for (const key of keys) {
      for (const seed of [0, 1, 42, 12345, 999999, 2 ** 31 - 1]) {
        const a = openingLine(key, seed);
        const b = openingLine(key, seed);
        expect(a).toBe(b);
        expect(a.length).toBeGreaterThan(0);
      }
    }
  });

  it("不同 seed 至少产生不同句式（池大小 > 1，16 个 seed 内必撞出差异）", () => {
    const seen = new Set<string>();
    for (let s = 0; s < 16; s += 1) seen.add(openingLine("TUTOR", s));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("开局白不含任何题面 / 作者 / 诗名（红线）", () => {
    const forbidden = [
      "床前明月光",
      "李白",
      "静夜思",
      "春晓",
      "孟浩然",
    ];
    for (const key of ["TUTOR", "EXAMINER", "EMPEROR"] as const) {
      for (let s = 0; s < 32; s += 1) {
        const line = openingLine(key, s);
        for (const f of forbidden) expect(line).not.toContain(f);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* feedbackLine                                                        */
/* ------------------------------------------------------------------ */

describe("feedbackLine 判题反馈", () => {
  const explanation = "出自《静夜思》 · 唐 · 李白";

  it("同输入同句（确定性，可复现）", () => {
    const input = { correct: true, combo: 3, explanation };
    expect(feedbackLine("TUTOR", input)).toBe(feedbackLine("TUTOR", input));
    const input2 = { correct: false, combo: 0, explanation };
    expect(feedbackLine("EXAMINER", input2)).toBe(feedbackLine("EXAMINER", input2));
    const input3 = { correct: true, timeout: true, combo: 0, explanation };
    expect(feedbackLine("EMPEROR", input3)).toBe(feedbackLine("EMPEROR", input3));
  });

  it("答对以「对。」开头；combo>=3 追加夸奖（仍为固定池文案）", () => {
    const plain = feedbackLine("TUTOR", { correct: true, combo: 1, explanation });
    expect(plain.startsWith("对。")).toBe(true);
    expect(plain).toContain(explanation);
    // combo>=3 时追加夸奖池文案：同一 explanation 下，存在 seed 输入使长度 > combo=1 的句子
    let hasLonger = false;
    for (let i = 0; i < 64; i += 1) {
      const withCombo = feedbackLine("TUTOR", { correct: true, combo: 3, explanation: `说明材料${i}` });
      const withoutCombo = feedbackLine("TUTOR", { correct: true, combo: 1, explanation: `说明材料${i}` });
      if (withCombo.length > withoutCombo.length) { hasLonger = true; break; }
    }
    expect(hasLonger).toBe(true);
  });

  it("答错以「错。」开头；超时以「时辰到了。」开头", () => {
    expect(feedbackLine("EXAMINER", { correct: false, combo: 0, explanation })).toMatch(/^错。/);
    expect(feedbackLine("EXAMINER", { correct: true, timeout: true, combo: 0, explanation })).toMatch(/^时辰到了。/);
  });

  it("不含未作答轮的答案信息（红线：反馈句不得携带其他轮次的答案内容）", () => {
    // 构造 4 轮题（含 GUESS_POET / GUESS_TITLE，其 explanation 判后揭晓含正确答案）
    const rand = mulberry32(7);
    const rounds: PoetryRound[] = [];
    for (let i = 0; i < 4; i += 1) {
      const type = i % 2 === 0 ? PoetryQuestionType.GUESS_POET : PoetryQuestionType.GUESS_TITLE;
      rounds.push(materializeRound(type, corpus[0], 0, corpus, i, rand, true));
    }
    // 对第 0 轮（GUESS_POET，答案=李白）反馈：不得携带第 2 轮的答案（同为 GUESS_POET 同素材但不同 prompt 维度）
    // 用不同素材构造：第 0 轮 p1 / 第 1 轮 p2，答案互异（李白 vs 春晓/孟浩然）
    const r0 = materializeRound(PoetryQuestionType.GUESS_POET, corpus[0], 0, corpus, 0, rand, true);
    const r1 = materializeRound(PoetryQuestionType.GUESS_POET, corpus[1], 0, corpus, 1, rand, true);
    expect(r0.options).toContain("李白");
    expect(r1.options).toContain("孟浩然");
    const feedback = feedbackLine("TUTOR", {
      correct: true,
      combo: 1,
      explanation: `出自《${r0.meta.poemTitle}》 · ${r0.meta.dynasty} · ${r0.meta.poet}`,
    });
    // 第 1 轮（未作答）的作者答案不得出现在第 0 轮的反馈句里
    expect(feedback).not.toContain("孟浩然");
  });
});

/* ------------------------------------------------------------------ */
/* 结算台词                                                            */
/* ------------------------------------------------------------------ */

describe("结算台词", () => {
  it("promotionLine：普通擢升与登极专用句", () => {
    expect(promotionLine("EXAMINER", "布衣", "童生")).toBe("布衣中式，擢升童生。");
    expect(promotionLine("EMPEROR", "丞相", "皇帝")).toBe("丞相中式，天子登极。");
    // toLabel=皇帝 时即使 key 非 EMPEROR 也走登极句
    expect(promotionLine("EXAMINER", "丞相", "皇帝")).toBe("丞相中式，天子登极。");
  });

  it("failLine 含正确率与缺口口径", () => {
    expect(failLine(50)).toContain("50%");
    expect(failLine(50)).toContain("还差 1 题"); // 60% 线：10 题制 5 对 → 差 1
    expect(failLine(30)).toContain("还差 3 题");
    expect(failLine(0)).toContain("还差 6 题");
  });

  it("practiceLine 含功名入账数", () => {
    expect(practiceLine(800)).toBe("这一卷记下 800 功名。");
  });
});

/* ------------------------------------------------------------------ */
/* 红线：判前视图不含答案（start/resume 下发的 rounds）                  */
/* ------------------------------------------------------------------ */

describe("判前视图红线：toRoundView 输出不含答案", () => {
  it("100 个 round 的 toRoundView 输出均不含 answerIndex / sourceKey / meta / 正确选项序", () => {
    const rand = mulberry32(20260920);
    const types = [
      PoetryQuestionType.GUESS_POET,
      PoetryQuestionType.GUESS_TITLE,
      PoetryQuestionType.COMPLETE_NEXT,
    ];
    let made = 0;
    for (let i = 0; i < 100 && made < 100; i += 1) {
      const item = corpus[i % corpus.length];
      const lineIndex = (i % (item.lines.length - 1));
      const type = types[i % types.length];
      const round = materializeRound(type, item, lineIndex, corpus, made, rand, true);
      if (round.answerIndex < 0) continue;
      const view = toRoundView(round);
      // 视图字段白名单：只有 roundIndex / type / prompt / options
      expect(Object.keys(view).sort()).toEqual(
        ["options", "prompt", "roundIndex", "type"].sort(),
      );
      // 不含答案索引
      expect(view).not.toHaveProperty("answerIndex");
      // 不含素材身份
      expect(view).not.toHaveProperty("sourceKey");
      expect(view).not.toHaveProperty("meta");
      // 正确选项序不可推得：options 顺序不等于「正确答案恒在固定位」
      // （对同素材 16 个 seed 采样，answerIndex 分布在 ≥2 个位置）
      made += 1;
    }
    expect(made).toBe(100);

    // 同素材多 seed：answerIndex 至少 2 个不同位置（客户端无法以固定下标猜答案）
    const positions = new Set<number>();
    for (let s = 0; s < 16; s += 1) {
      const r = materializeRound(
        PoetryQuestionType.GUESS_POET,
        corpus[0],
        0,
        corpus,
        0,
        mulberry32(s),
        true,
      );
      positions.add(r.answerIndex);
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it("pickQuote 题干不含正确答案（GUESS_POET/GUESS_TITLE 题干 = 诗句本身）", () => {
    const quote = pickQuote(corpus[0], 0);
    expect(quote).not.toContain("李白");
    expect(quote).not.toContain("静夜思");
  });
});
