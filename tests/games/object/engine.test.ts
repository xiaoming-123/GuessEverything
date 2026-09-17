import { describe, expect, it } from "vitest";
import { buildRounds, filterByDifficulty } from "@/lib/games/object/engine";
import { categoryDistractorPool } from "@/lib/games/object/distractors";
import {
  CATEGORY_LABEL,
  ObjectCategory,
  ObjectCorpusItem,
  ObjectDifficulty,
  ObjectQuestionType,
  toRoundView,
} from "@/lib/games/object/types";
import seedJson from "@/lib/data/object-seed.json";

const corpus: ObjectCorpusItem[] = [
  {
    id: "c1",
    name: "物品甲",
    category: ObjectCategory.ANIMAL,
    difficulty: 1,
    clues: ["线索甲1", "线索甲2", "线索甲3"],
    riddle: "谜语甲",
  },
  {
    id: "c2",
    name: "物品乙",
    category: ObjectCategory.ANIMAL,
    difficulty: 1,
    clues: ["线索乙1", "线索乙2", "线索乙3"],
    riddle: "谜语乙",
  },
  {
    id: "c3",
    name: "物品丙",
    category: ObjectCategory.FOOD,
    difficulty: 2,
    clues: ["线索丙1", "线索丙2", "线索丙3"],
  },
  {
    id: "c4",
    name: "物品丁",
    category: ObjectCategory.NATURE,
    difficulty: 2,
    clues: ["线索丁1", "线索丁2", "线索丁3"],
    riddle: "谜语丁",
  },
  {
    id: "c5",
    name: "物品戊",
    category: ObjectCategory.DAILY,
    difficulty: 3,
    clues: ["线索戊1", "线索戊2", "线索戊3"],
  },
];

const seed = seedJson as ObjectCorpusItem[];

describe("filterByDifficulty", () => {
  it("入门档只取 difficulty=1", () => {
    const scoped = filterByDifficulty(corpus, ObjectDifficulty.EASY);
    expect(scoped.map((o) => o.id).sort()).toEqual(["c1", "c2"]);
  });

  it("进阶档包含 1-2", () => {
    const scoped = filterByDifficulty(corpus, ObjectDifficulty.NORMAL);
    expect(scoped.map((o) => o.id).sort()).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("骨灰档包含 1-3", () => {
    expect(filterByDifficulty(corpus, ObjectDifficulty.HARD)).toHaveLength(5);
  });
});

describe("buildRounds", () => {
  it("生成指定数量的轮次且轮次编号连续", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ObjectDifficulty.HARD,
      count: 8,
      seed: 42,
    });
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds.length).toBeLessThanOrEqual(8);
    rounds.forEach((r, i) => expect(r.roundIndex).toBe(i));
  });

  it("同种子结果可复现", () => {
    const a = buildRounds(corpus, { difficulty: ObjectDifficulty.HARD, count: 10, seed: 7 });
    const b = buildRounds(corpus, { difficulty: ObjectDifficulty.HARD, count: 10, seed: 7 });
    expect(b).toEqual(a);
  });

  it("每轮 4 个不重复选项、答案索引合法", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ObjectDifficulty.HARD,
      count: 13,
      seed: 1,
    });
    expect(rounds.length).toBe(13);
    for (const r of rounds) {
      expect(r.options).toHaveLength(4);
      expect(new Set(r.options).size).toBe(4);
      expect(r.answerIndex).toBeGreaterThanOrEqual(0);
      expect(r.answerIndex).toBeLessThan(4);
    }
  });

  it("线索题/谜语题：答案为该物品名，且携带线索", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ObjectDifficulty.HARD,
      count: 13,
      seed: 3,
    });
    const guessName = rounds.filter(
      (r) =>
        r.type === ObjectQuestionType.GUESS_FROM_CLUES ||
        r.type === ObjectQuestionType.GUESS_FROM_RIDDLE,
    );
    expect(guessName.length).toBeGreaterThan(0);
    for (const r of guessName) {
      expect(r.options[r.answerIndex]).toBe(r.meta.name);
      expect(r.clues.length).toBeGreaterThan(0);
    }
  });

  it("谜语题：题面是谜面，且只出自有 riddle 的物品", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ObjectDifficulty.HARD,
      count: 13,
      seed: 3,
    });
    const riddleRounds = rounds.filter(
      (r) => r.type === ObjectQuestionType.GUESS_FROM_RIDDLE,
    );
    expect(riddleRounds.length).toBeGreaterThan(0);
    for (const r of riddleRounds) {
      expect(r.prompt).toBe(r.meta.riddle);
      const item = corpus.find((o) => o.name === r.meta.name)!;
      expect(item.riddle).toBeTruthy();
    }
  });

  it("无谜语的物品不出谜语题", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ObjectDifficulty.HARD,
      count: 13,
      seed: 3,
    });
    const riddleNames = rounds
      .filter((r) => r.type === ObjectQuestionType.GUESS_FROM_RIDDLE)
      .map((r) => r.meta.name);
    expect(riddleNames).not.toContain("物品丙");
    expect(riddleNames).not.toContain("物品戊");
  });

  it("分类题：答案为正确分类标签", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ObjectDifficulty.HARD,
      count: 13,
      seed: 3,
    });
    const categoryRounds = rounds.filter(
      (r) => r.type === ObjectQuestionType.GUESS_CATEGORY,
    );
    expect(categoryRounds.length).toBeGreaterThan(0);
    for (const r of categoryRounds) {
      expect(r.options[r.answerIndex]).toBe(CATEGORY_LABEL[r.meta.category]);
    }
  });

  it("toRoundView 剥离答案与 meta，但保留 clues", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ObjectDifficulty.HARD,
      count: 3,
      seed: 9,
    });
    const view = toRoundView(rounds[0]);
    expect(view).not.toHaveProperty("answerIndex");
    expect(view).not.toHaveProperty("meta");
    expect(view.clues).toBeInstanceOf(Array);
    expect(Object.keys(view).sort()).toEqual([
      "clues",
      "options",
      "prompt",
      "roundIndex",
      "type",
    ]);
  });
});

describe("干扰项策略", () => {
  it("猜分类：干扰项来自其余 5 个分类且不含正确分类", () => {
    const pool = categoryDistractorPool(ObjectCategory.ANIMAL);
    expect(pool).toHaveLength(5);
    expect(pool).not.toContain(CATEGORY_LABEL.ANIMAL);
    expect(new Set(pool).size).toBe(5);
  });
});

describe("种子语料完整性", () => {
  it("共 30 件物品，名称唯一", () => {
    expect(seed).toHaveLength(30);
    expect(new Set(seed.map((o) => o.name)).size).toBe(30);
  });

  it("每件物品恰好 3 条线索，分类与难度合法", () => {
    for (const o of seed) {
      expect(o.clues).toHaveLength(3);
      expect(Object.values(ObjectCategory)).toContain(o.category);
      expect([1, 2, 3]).toContain(o.difficulty);
    }
  });

  it("谜语为非空字符串，且至少 20 件物品带谜语", () => {
    const withRiddle = seed.filter((o) => o.riddle && o.riddle.length > 0);
    expect(withRiddle.length).toBeGreaterThanOrEqual(20);
  });

  it("入门档真实种子可出满 10 题且每题 4 个不重复选项", () => {
    const rounds = buildRounds(seed, {
      difficulty: ObjectDifficulty.EASY,
      count: 10,
      seed: 20260914,
    });
    expect(rounds).toHaveLength(10);
    for (const r of rounds) {
      expect(r.options).toHaveLength(4);
      expect(new Set(r.options).size).toBe(4);
    }
  });
});
