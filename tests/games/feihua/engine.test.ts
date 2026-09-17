import { describe, expect, it } from "vitest";
import { buildRounds, filterByDifficulty, materialKey } from "@/lib/games/feihua/engine";
import {
  buildLingIndex,
  buildSentences,
  gradeToDifficulty,
  LING_CHARS,
  MIN_SENTENCE_LEN,
} from "@/lib/games/feihua/corpus";
import {
  FeihuaDifficulty,
  FeihuaQuestionType,
  toRoundView,
  type FeihuaRound,
} from "@/lib/games/feihua/types";
import type { PoemCorpusItem } from "@/lib/games/poetry/types";
import seedJson from "@/lib/data/poetry-seed.json";

const seedCorpus = seedJson as PoemCorpusItem[];

/** 校验每一轮的结构与含字关系不变量 */
function expectRoundValid(round: FeihuaRound) {
  expect(round.options).toHaveLength(4);
  expect(new Set(round.options)).toHaveLength(4);
  expect(round.answerIndex).toBeGreaterThanOrEqual(0);
  expect(round.answerIndex).toBeLessThan(4);
  expect(round.meta.lingChar).toHaveLength(1);
  expect(LING_CHARS).toContain(round.meta.lingChar);
  const correct = round.options[round.answerIndex];

  if (round.type === FeihuaQuestionType.FIND_CONTAINS) {
    expect(round.prompt).toBe("");
    expect(correct).toContain(round.meta.lingChar);
    round.options.forEach((opt, i) => {
      if (i !== round.answerIndex) expect(opt).not.toContain(round.meta.lingChar);
    });
  } else if (round.type === FeihuaQuestionType.FIND_MISSING) {
    expect(round.prompt).toBe("");
    expect(correct).not.toContain(round.meta.lingChar);
    round.options.forEach((opt, i) => {
      if (i !== round.answerIndex) expect(opt).toContain(round.meta.lingChar);
    });
  } else {
    expect(round.prompt).toBe(round.meta.sentence);
    expect(round.prompt.length).toBeGreaterThanOrEqual(MIN_SENTENCE_LEN);
    expect(correct).toBe(round.meta.lingChar);
    expect(round.prompt).toContain(correct);
    round.options.forEach((opt, i) => {
      expect(opt).toHaveLength(1);
      if (i !== round.answerIndex) expect(round.prompt).not.toContain(opt);
    });
  }
}

describe("飞花令 · 语料构建", () => {
  it("grade 映射到 1/2/3 难度", () => {
    expect(gradeToDifficulty(1)).toBe(1);
    expect(gradeToDifficulty(6)).toBe(1);
    expect(gradeToDifficulty(7)).toBe(2);
    expect(gradeToDifficulty(9)).toBe(2);
    expect(gradeToDifficulty(10)).toBe(3);
    expect(gradeToDifficulty(12)).toBe(3);
  });

  it("拆句：短残句剔除、重复句去重、ID 与出处保留", () => {
    const poems: PoemCorpusItem[] = [
      {
        id: "t1",
        title: "测试诗",
        poet: "某人",
        dynasty: "唐",
        grade: 2,
        famous: true,
        lines: ["春眠不觉晓", "短", "处处闻啼鸟", "春眠不觉晓"],
      },
    ];
    const sentences = buildSentences(poems);
    expect(sentences.map((s) => s.text)).toEqual(["春眠不觉晓", "处处闻啼鸟"]);
    expect(sentences[0]).toMatchObject({
      id: "t1#0",
      poemId: "t1",
      poemTitle: "测试诗",
      difficulty: 1,
    });
  });

  it("令字索引只保留命中数达标的令字", () => {
    const poems: PoemCorpusItem[] = [
      {
        id: "t2",
        title: "春诗",
        poet: "甲",
        dynasty: "唐",
        grade: 1,
        famous: false,
        lines: ["春风又绿江南岸", "春江水暖鸭先知", "春来江水绿如蓝", "二月春风似剪刀"],
      },
      {
        id: "t3",
        title: "无春",
        poet: "乙",
        dynasty: "唐",
        grade: 1,
        famous: false,
        lines: ["床前明月光", "疑是地上霜", "举头望明月", "低头思故乡"],
      },
    ];
    const index = buildLingIndex(buildSentences(poems));
    expect(index.get("春")).toHaveLength(4);
    // 「月」命中 3 句（明月光 / 望明月 / 二月春风）刚好达标入索引
    expect(index.get("月")).toHaveLength(3);
    // 「霜」仅 1 句，不达门槛，不入索引
    expect(index.has("霜")).toBe(false);
  });
});

describe("飞花令 · 出题引擎（真实种子语料）", () => {
  it.each([FeihuaDifficulty.EASY, FeihuaDifficulty.NORMAL, FeihuaDifficulty.HARD])(
    "%s 三档均能出满 10 题且全部合法",
    (difficulty) => {
      const rounds = buildRounds(seedCorpus, { difficulty, count: 10, seed: 42 });
      expect(rounds).toHaveLength(10);
      rounds.forEach((round, i) => {
        expect(round.roundIndex).toBe(i);
        expectRoundValid(round);
      });
    },
  );

  it("入门档只出寻句题", () => {
    const rounds = buildRounds(seedCorpus, {
      difficulty: FeihuaDifficulty.EASY,
      count: 10,
      seed: 7,
    });
    expect(rounds.every((r) => r.type === FeihuaQuestionType.FIND_CONTAINS)).toBe(true);
  });

  it("进阶档包含猜令题，骨灰档三种题型齐全", () => {
    const normalTypes = new Set<FeihuaQuestionType>();
    for (let seed = 1; seed <= 8; seed++) {
      buildRounds(seedCorpus, { difficulty: FeihuaDifficulty.NORMAL, count: 10, seed }).forEach(
        (r) => normalTypes.add(r.type),
      );
    }
    expect(normalTypes.has(FeihuaQuestionType.GUESS_CHAR)).toBe(true);

    const hardTypes = new Set<FeihuaQuestionType>();
    for (let seed = 1; seed <= 8; seed++) {
      buildRounds(seedCorpus, { difficulty: FeihuaDifficulty.HARD, count: 10, seed }).forEach(
        (r) => hardTypes.add(r.type),
      );
    }
    expect(hardTypes.size).toBe(3);
  });

  it("同局正确答案不重复（诗句/令字）", () => {
    for (const difficulty of [
      FeihuaDifficulty.EASY,
      FeihuaDifficulty.NORMAL,
      FeihuaDifficulty.HARD,
    ] as const) {
      const rounds = buildRounds(seedCorpus, { difficulty, count: 10, seed: 99 });
      const answers = rounds.map((r) => r.options[r.answerIndex]);
      expect(new Set(answers)).toHaveLength(answers.length);
    }
  });

  it("种子相同则对局可复现", () => {
    const a = buildRounds(seedCorpus, { difficulty: FeihuaDifficulty.HARD, count: 10, seed: 123 });
    const b = buildRounds(seedCorpus, { difficulty: FeihuaDifficulty.HARD, count: 10, seed: 123 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("素材 key 形如 诗ID#句位:题型", () => {
    const rounds = buildRounds(seedCorpus, {
      difficulty: FeihuaDifficulty.EASY,
      count: 5,
      seed: 3,
    });
    for (const round of rounds) {
      expect(round.sourceKey).toMatch(/^p\d+#\d+:[A-Z_]+$/);
      expect(round.sourceKey.endsWith(round.type)).toBe(true);
    }
  });

  it("视图剥离 answerIndex / sourceKey / meta", () => {
    const [round] = buildRounds(seedCorpus, {
      difficulty: FeihuaDifficulty.NORMAL,
      count: 1,
      seed: 5,
    });
    const view = toRoundView(round);
    expect(view).not.toHaveProperty("answerIndex");
    expect(view).not.toHaveProperty("sourceKey");
    expect(view).not.toHaveProperty("meta");
    expect(view).toEqual({
      roundIndex: 0,
      type: round.type,
      prompt: round.prompt,
      options: round.options,
      lingChar:
        round.type === FeihuaQuestionType.GUESS_CHAR ? "" : round.meta.lingChar,
    });
  });

  it("空语料 / 极少句子时安全返回空数组", () => {
    expect(buildRounds([], { difficulty: FeihuaDifficulty.EASY, count: 10 })).toEqual([]);
    const tiny: PoemCorpusItem[] = [
      {
        id: "x1",
        title: "独句",
        poet: "谁",
        dynasty: "唐",
        grade: 1,
        famous: false,
        lines: ["春风又绿江南岸"],
      },
    ];
    // 句子不足 4 个，无法凑选项
    expect(buildRounds(tiny, { difficulty: FeihuaDifficulty.EASY, count: 10 })).toEqual([]);
  });

  it("跨局防重复：excludeKeys 中的素材不出现在首轮候选", () => {
    const first = buildRounds(seedCorpus, {
      difficulty: FeihuaDifficulty.EASY,
      count: 10,
      seed: 2024,
    });
    // 排除全部首轮素材后，第二局不应再用这些 key（语料足够时）
    const second = buildRounds(seedCorpus, {
      difficulty: FeihuaDifficulty.EASY,
      count: 10,
      seed: 2024,
      excludeKeys: first.map((r) => r.sourceKey),
    });
    const firstKeys = new Set(first.map((r) => r.sourceKey));
    expect(second.every((r) => !firstKeys.has(r.sourceKey))).toBe(true);
  });
});

describe("飞花令 · 难度过滤", () => {
  it("入门档只含难度 1 的句子，语料不足回退全量", () => {
    const sentences = buildSentences(seedCorpus);
    const easy = filterByDifficulty(sentences, FeihuaDifficulty.EASY);
    expect(easy.every((s) => s.difficulty === 1)).toBe(true);
    // 传入全是难度 3 的句子查入门档：回退全量而非空数组
    const hardOnly = sentences.filter((s) => s.difficulty === 3);
    expect(filterByDifficulty(hardOnly, FeihuaDifficulty.EASY)).toHaveLength(hardOnly.length);
  });

  it("materialKey 同句不同题型不同 key", () => {
    const [s] = buildSentences(seedCorpus);
    expect(materialKey(s, FeihuaQuestionType.FIND_CONTAINS)).not.toBe(
      materialKey(s, FeihuaQuestionType.GUESS_CHAR),
    );
  });
});
