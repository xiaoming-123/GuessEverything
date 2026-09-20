import { describe, expect, it } from "vitest";
import {
  buildRankedRounds,
  buildRounds,
  materialKey,
  faceKey,
  rankedRoundPool,
} from "@/lib/games/poetry/engine";
import {
  PoetryQuestionType,
  PoetryStage,
  toRoundView,
  type PoemCorpusItem,
  type PoetryRound,
} from "@/lib/games/poetry/types";
import { RANKS } from "@/lib/games/poetry/rank";
import { fillCharPositions } from "@/lib/games/poetry/distractors";

/** 4 句诗素材构造器 */
const P = (
  id: string,
  grade: number,
  poet: string,
  dynasty: string,
  title: string,
  lines: string[],
): PoemCorpusItem => ({ id, title, poet, dynasty, grade, lines, famous: true });

/**
 * 测试语料（每首 4 句 → 每首 6 个素材；窗口内 ≥2 首 → ≥12 素材，足量 10 题）：
 * - a0/a1 grade 1，a2 grade 2，a3 grade 3：低阶窗口（rank0 研习 1–3 含 a0/a1/a2/a3）。
 * - b0/b1 grade 12，且**逐字相同**（不同 poemId）：用于「换 ID 不改题面」去重。
 *   rank9 研习窗口 11–12 仅 b0/b1 → faceKey 去重后 fresh 仅 6 < 10（用于容量不足/越级用例）。
 */
const corpus: PoemCorpusItem[] = [
  P("a0", 1, "李白", "唐", "静夜思", ["床前明月光", "疑是地上霜", "举头望明月", "低头思故乡"]),
  P("a1", 1, "孟浩然", "唐", "春晓", ["春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少"]),
  P("a2", 2, "王维", "唐", "鹿柴", ["空山不见人", "但闻人语响", "返景入深林", "复照青苔上"]),
  P("a3", 3, "杜甫", "唐", "春望", ["国破山河在", "城春草木深", "感时花溅泪", "恨别鸟惊心"]),
  // b0 / b1：内容逐字相同（同标题/同诗句/同作者），仅稳定 id 不同 → 题面(faceKey)完全一致。
  // 这正是「换 ID 不改题面」去重要防的情形。
  P("b0", 12, "杜甫", "唐", "登高", ["风急天高猿啸哀", "渚清沙白鸟飞回", "无边落木萧萧下", "不尽长江滚滚来"]),
  P("b1", 12, "杜甫", "唐", "登高", ["风急天高猿啸哀", "渚清沙白鸟飞回", "无边落木萧萧下", "不尽长江滚滚来"]),
];

const sourceKeyOf = (rounds: PoetryRound[]) => rounds.map((r) => r.sourceKey);

/** 枚举某官阶某 kind 窗口内全部素材的 sourceKey（用于构造「全部已见」排除集） */
function allKeysInWindow(rankId: number, kind: "PRACTICE" | "EXAM" | "DAILY"): string[] {
  const r = RANKS[rankId];
  const [lo, hi] = kind === "EXAM" ? r.examWindow : r.gradeWindow;
  const keys: string[] = [];
  for (const p of corpus) {
    if (p.grade < lo || p.grade > hi) continue;
    for (let i = 0; i < p.lines.length - 1; i++) {
      keys.push(materialKey(p, i, PoetryQuestionType.GUESS_POET));
      keys.push(materialKey(p, i, PoetryQuestionType.GUESS_TITLE));
      keys.push(materialKey(p, i, PoetryQuestionType.COMPLETE_NEXT));
    }
  }
  return keys;
}

describe("buildRankedRounds · 严格官阶出卷", () => {
  it("跨窗口的已见同题仍排除，素材 id 可包含冒号", () => {
    const earlier = { ...corpus[0], id: "old:poem", grade: 12 };
    const data = [...corpus, earlier];
    const seen = materialKey(earlier, 0, PoetryQuestionType.COMPLETE_NEXT);
    const pool = rankedRoundPool(data, { rankId: 0, kind: "PRACTICE", seed: 1, excludeKeys: [seen] });
    expect(pool.some((r) => r.sourceKey === materialKey(corpus[0], 0, PoetryQuestionType.COMPLETE_NEXT))).toBe(false);
  });

  it("原素材已删除时，持久化题面身份仍能阻止重出", () => {
    const face = faceKey(corpus[0], 0, PoetryQuestionType.COMPLETE_NEXT);
    const pool = rankedRoundPool(corpus, { rankId: 0, kind: "PRACTICE", seed: 1, excludeFaces: [face] });
    expect(pool.some((r) => r.sourceKey === materialKey(corpus[0], 0, PoetryQuestionType.COMPLETE_NEXT))).toBe(false);
  });

  it("不足四个有效选项的题不计入可用容量，猜诗人不能拿诗句充数", () => {
    const tiny = [P("tiny", 1, "李白", "唐", "短诗", ["甲", "乙"])];
    expect(buildRankedRounds(tiny, { rankId: 0, kind: "DAILY", seed: 1 }))
      .toEqual({ ok: false, reason: "INSUFFICIENT_CAPACITY", available: 0, required: 1 });
    const pool = rankedRoundPool([corpus[0]], { rankId: 0, kind: "PRACTICE", seed: 1 });
    expect(pool.every((r) => r.type === PoetryQuestionType.COMPLETE_NEXT)).toBe(true);
  });
  it("足量时产出恰好 required 题、编号连续、4 选项唯一、答案正确、可剥离", () => {
    const res = buildRankedRounds(corpus, { rankId: 0, kind: "PRACTICE", seed: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rounds).toHaveLength(10);
    res.rounds.forEach((r, i) => {
      expect(r.roundIndex).toBe(i);
      expect(r.options).toHaveLength(4);
      expect(new Set(r.options).size).toBe(4);
      expect(r.answerIndex).toBeGreaterThanOrEqual(0);
      expect(r.answerIndex).toBeLessThan(4);
      expect(toRoundView(r)).not.toHaveProperty("answerIndex");
    });
  });

  it("严格不重复：排除全部已见后返回 INSUFFICIENT_CAPACITY(available 0)，绝不回退/借题/自动晋升", () => {
    // rank0 研习窗口 1–3：a0/a1(1) + a2(2) + a3(3) = 4 首；每首 3 句位 × 3 题型 = 9 素材 → 36
    const allSeen = allKeysInWindow(0, "PRACTICE");
    expect(allSeen.length).toBe(36);
    const res = buildRankedRounds(corpus, { rankId: 0, kind: "PRACTICE", seed: 5, excludeKeys: allSeen });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("INSUFFICIENT_CAPACITY");
    expect(res.available).toBe(0);
    expect(res.required).toBe(10);
  });

  it("部分已见：只在剩余 fresh 里出，已见 sourceKey 一律不出现", () => {
    const seen = [materialKey(corpus[0], 0, PoetryQuestionType.GUESS_POET)];
    const res = buildRankedRounds(corpus, { rankId: 0, kind: "PRACTICE", seed: 7, excludeKeys: seen });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rounds).toHaveLength(10);
    for (const k of sourceKeyOf(res.rounds)) {
      expect(seen).not.toContain(k);
    }
  });

  it("不越级借题：只出本官阶窗口 grade 的题（不借更高档 b0/b1）", () => {
    // 四位诗人及四个诗名，确保窗口内有足够的同类型干扰项。
    const data = corpus.map((p) => p.grade === 1 ? { ...p, grade: 2 } : p);
    const res = buildRankedRounds(data, { rankId: 2, kind: "PRACTICE", seed: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const inWindow = new Set(
      data.filter((p) => p.grade >= 2 && p.grade <= 5).map((p) => p.id),
    );
    expect(inWindow.size).toBe(4);
    for (const r of res.rounds) {
      const poemId = r.sourceKey.split(":")[0];
      expect(inWindow.has(poemId)).toBe(true); // 绝无 grade 12 的 b0/b1
    }
  });

  it("越级窗口不足时不借高阶：返回 INSUFFICIENT_CAPACITY 而非借题", () => {
    // rank9 丞相研习窗口 11–12，本语料只有 b0/b1(12) 且逐字相同 → fresh 6 < 10
    const res = buildRankedRounds(corpus, { rankId: 9, kind: "PRACTICE", seed: 11 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("INSUFFICIENT_CAPACITY");
    expect(res.available).toBeLessThan(10);
    expect(res.required).toBe(10);
  });

  it("同题面不可换 ID 绕过：排除 b0 后，逐字相同的 b1 也不出（faceKey 去重）", () => {
    // b0 = corpus[4]，b1 = corpus[5]（逐字相同）。排除 b0 的**全部**题面：
    //   · 3 基础题型 × 3 句位
    //   · DYNASTY_PICK × 3 句位（朝代配对，无 pos 维度）
    //   · FILL_CHAR × 3 句位 × 每 CJK 挖字位（pos 维度展开）
    // b1 内容逐字相同 → b1 的全部题面 ⊆ b0 题面 → fresh 归 0。
    // （只排除 3 基础题型会漏掉新题型 faceKey → 防线失效，正是 D3 要防的回归。）
    const lineIdx = [0, 1, 2];
    const baseTypes: PoetryQuestionType[] = [
      PoetryQuestionType.GUESS_POET,
      PoetryQuestionType.GUESS_TITLE,
      PoetryQuestionType.COMPLETE_NEXT,
      PoetryQuestionType.DYNASTY_PICK,
    ];
    const b0Keys: string[] = [];
    for (const i of lineIdx) {
      for (const t of baseTypes) b0Keys.push(materialKey(corpus[4], i, t));
      // FILL_CHAR：遍历句中每个 CJK 挖字位（《登高》每句 7 字全 CJK → 每句 7 位）
      for (const pos of fillCharPositions(corpus[4].lines[i])) {
        b0Keys.push(materialKey(corpus[4], i, PoetryQuestionType.FILL_CHAR, pos));
      }
    }
    expect(b0Keys.length).toBe(12 + 21); // 3 基础+朝代 × 3 句位 + 7 字 × 3 句位
    const res = buildRankedRounds(corpus, { rankId: 9, kind: "EXAM", seed: 13, excludeKeys: b0Keys });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.available).toBe(0);
  });

  it("窗口内无语料 → EMPTY_CORPUS", () => {
    const onlyHigh: PoemCorpusItem[] = [corpus[4]]; // 仅 grade 12
    const res = buildRankedRounds(onlyHigh, { rankId: 0, kind: "PRACTICE", seed: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("EMPTY_CORPUS");
      expect(res.available).toBe(0);
    }
  });

  it("种子确定性：同 seed 同语料同排除集，输出逐字一致；不同 seed 可区分", () => {
    const a = buildRankedRounds(corpus, { rankId: 0, kind: "PRACTICE", seed: 2026 });
    const b = buildRankedRounds(corpus, { rankId: 0, kind: "PRACTICE", seed: 2026 });
    expect(a).toEqual(b);
    const c = buildRankedRounds(corpus, { rankId: 0, kind: "PRACTICE", seed: 1 });
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c));
  });

  it("题数随 kind 变化（科考 10 / 每日 1）", () => {
    const exam = buildRankedRounds(corpus, { rankId: 0, kind: "EXAM", seed: 2 });
    expect(exam.ok).toBe(true);
    if (exam.ok) expect(exam.rounds).toHaveLength(10);
    const daily = buildRankedRounds(corpus, { rankId: 0, kind: "DAILY", seed: 2 });
    expect(daily.ok).toBe(true);
    if (daily.ok) expect(daily.rounds).toHaveLength(1);
  });

  it("皇帝 Boss：需 15 题，本语料 fresh 6 → 容量不足", () => {
    const res = buildRankedRounds(corpus, { rankId: 10, kind: "EXAM", seed: 4 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.required).toBe(15);
  });
});

describe("faceKey / materialKey 身份", () => {
  it("materialKey 稳定且区分句位与题型", () => {
    const p = corpus[0];
    expect(materialKey(p, 0, PoetryQuestionType.GUESS_POET)).toBe("a0:0:GUESS_POET");
    expect(materialKey(p, 1, PoetryQuestionType.GUESS_POET)).not.toBe(materialKey(p, 0, PoetryQuestionType.GUESS_POET));
    expect(materialKey(p, 0, PoetryQuestionType.COMPLETE_NEXT)).not.toBe(materialKey(p, 0, PoetryQuestionType.GUESS_POET));
  });

  it("faceKey 跨 poemId 识别同题面（同题干同答案同题型）", () => {
    const f0 = faceKey(corpus[4], 0, PoetryQuestionType.GUESS_POET);
    const f1 = faceKey(corpus[5], 0, PoetryQuestionType.GUESS_POET);
    expect(f0).toBe(f1);
    expect(faceKey(corpus[4], 0, PoetryQuestionType.COMPLETE_NEXT)).not.toBe(
      faceKey(corpus[4], 1, PoetryQuestionType.COMPLETE_NEXT),
    );
  });

  it("同一首诗可在不同知识点再出现（不同句位/题型 → 不同题面，不算重复）", () => {
    const p = corpus[0];
    const keys = [
      faceKey(p, 0, PoetryQuestionType.GUESS_POET),
      faceKey(p, 0, PoetryQuestionType.COMPLETE_NEXT),
      faceKey(p, 1, PoetryQuestionType.GUESS_POET),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});

describe("旧学段模式兼容（不悄悄改变其他模式）", () => {
  it("buildRounds（stage 模式）行为保持：仍按学段出卷、含答案、可剥离", () => {
    const rounds = buildRounds(corpus, { stage: PoetryStage.PRIMARY, count: 6, seed: 9 });
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds.length).toBeLessThanOrEqual(6);
    rounds.forEach((r, i) => {
      expect(r.roundIndex).toBe(i);
      expect(toRoundView(r)).not.toHaveProperty("answerIndex");
    });
  });

  it("stage 模式仍可用（SENIOR 窗口回退全量亦可出卷），与 rank 入口互不干扰", () => {
    const rounds = buildRounds(corpus, { stage: PoetryStage.SENIOR, count: 10, seed: 4 });
    expect(rounds.length).toBeGreaterThan(0);
  });
});
