import { describe, expect, it } from "vitest";
import { buildRounds, filterByDifficulty } from "@/lib/games/actor/engine";
import { actorDistractorPool } from "@/lib/games/actor/distractors";
import {
  ActorCorpusItem,
  ActorDifficulty,
  ActorQuestionType,
  ActorRegion,
  toRoundView,
} from "@/lib/games/actor/types";
import seedJson from "@/lib/data/actor-seed.json";

const corpus: ActorCorpusItem[] = [
  {
    id: "b1",
    name: "演员甲",
    region: ActorRegion.MAINLAND,
    difficulty: 1,
    works: ["作品甲1", "作品甲2", "作品甲3"],
    roles: [
      { role: "角色甲1", work: "作品甲1" },
      { role: "角色甲2", work: "作品甲2" },
    ],
  },
  {
    id: "b2",
    name: "演员乙",
    region: ActorRegion.MAINLAND,
    difficulty: 1,
    works: ["作品乙1", "作品乙2", "作品乙3"],
    roles: [
      { role: "角色乙1", work: "作品乙1" },
      { role: "角色乙2", work: "作品乙2" },
    ],
  },
  {
    id: "b3",
    name: "演员丙",
    region: ActorRegion.HK_TW,
    difficulty: 2,
    works: ["作品丙1", "作品丙2", "作品丙3"],
    roles: [
      { role: "角色丙1", work: "作品丙1" },
      { role: "角色丙2", work: "作品丙2" },
    ],
  },
  {
    id: "b4",
    name: "演员丁",
    region: ActorRegion.OVERSEAS,
    difficulty: 2,
    works: ["作品丁1", "作品丁2", "作品丁3"],
    roles: [
      { role: "角色丁1", work: "作品丁1" },
      { role: "角色丁2", work: "作品丁2" },
    ],
  },
  {
    id: "b5",
    name: "演员戊",
    region: ActorRegion.MAINLAND,
    difficulty: 3,
    works: ["作品戊1", "作品戊2", "作品戊3"],
    roles: [
      { role: "角色戊1", work: "作品戊1" },
      { role: "角色戊2", work: "作品戊2" },
    ],
  },
];

const seed = seedJson as ActorCorpusItem[];

describe("filterByDifficulty", () => {
  it("入门档只取 difficulty=1", () => {
    const scoped = filterByDifficulty(corpus, ActorDifficulty.EASY);
    expect(scoped.map((a) => a.id).sort()).toEqual(["b1", "b2"]);
  });

  it("进阶档包含 1-2", () => {
    const scoped = filterByDifficulty(corpus, ActorDifficulty.NORMAL);
    expect(scoped.map((a) => a.id).sort()).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("骨灰档包含 1-3", () => {
    expect(filterByDifficulty(corpus, ActorDifficulty.HARD)).toHaveLength(5);
  });
});

describe("buildRounds", () => {
  it("生成指定数量的轮次且轮次编号连续", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ActorDifficulty.HARD,
      count: 8,
      seed: 42,
    });
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds.length).toBeLessThanOrEqual(8);
    rounds.forEach((r, i) => expect(r.roundIndex).toBe(i));
  });

  it("同种子结果可复现", () => {
    const a = buildRounds(corpus, { difficulty: ActorDifficulty.HARD, count: 10, seed: 7 });
    const b = buildRounds(corpus, { difficulty: ActorDifficulty.HARD, count: 10, seed: 7 });
    expect(b).toEqual(a);
  });

  it("每轮 4 个不重复选项、答案索引合法", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ActorDifficulty.HARD,
      count: 15,
      seed: 1,
    });
    expect(rounds.length).toBe(15);
    for (const r of rounds) {
      expect(r.options).toHaveLength(4);
      expect(new Set(r.options).size).toBe(4);
      expect(r.answerIndex).toBeGreaterThanOrEqual(0);
      expect(r.answerIndex).toBeLessThan(4);
    }
  });

  it("猜演员题型：答案为该演员姓名", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ActorDifficulty.HARD,
      count: 15,
      seed: 3,
    });
    const guessActor = rounds.filter(
      (r) =>
        r.type === ActorQuestionType.GUESS_FROM_WORKS ||
        r.type === ActorQuestionType.GUESS_FROM_ROLES,
    );
    expect(guessActor.length).toBeGreaterThan(0);
    for (const r of guessActor) {
      expect(r.options[r.answerIndex]).toBe(r.meta.actorName);
    }
  });

  it("猜作品题型：答案是该演员的作品，且 meta 携带角色名", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ActorDifficulty.HARD,
      count: 15,
      seed: 3,
    });
    const guessWork = rounds.filter((r) => r.type === ActorQuestionType.GUESS_WORK);
    expect(guessWork.length).toBeGreaterThan(0);
    for (const r of guessWork) {
      const actor = corpus.find((a) => a.name === r.meta.actorName)!;
      expect(actor.works).toContain(r.options[r.answerIndex]);
      expect(r.meta.role).toBeTruthy();
    }
  });

  it("toRoundView 剥离答案与 meta", () => {
    const rounds = buildRounds(corpus, {
      difficulty: ActorDifficulty.HARD,
      count: 3,
      seed: 9,
    });
    const view = toRoundView(rounds[0]);
    expect(view).not.toHaveProperty("answerIndex");
    expect(view).not.toHaveProperty("meta");
    expect(Object.keys(view).sort()).toEqual(["options", "prompt", "roundIndex", "type"]);
  });
});

describe("干扰项策略", () => {
  it("猜演员：同地区演员排在池前", () => {
    const pool = actorDistractorPool(corpus, "演员甲", ActorRegion.MAINLAND);
    expect(pool.slice(0, 2).sort()).toEqual(["演员乙", "演员戊"]);
  });
});

describe("种子语料完整性", () => {
  it("共 30 位演员，姓名唯一", () => {
    expect(seed).toHaveLength(30);
    expect(new Set(seed.map((a) => a.name)).size).toBe(30);
  });

  it("每人至少 2 部作品、1 个角色，角色必须归属其作品", () => {
    for (const a of seed) {
      expect(a.works.length).toBeGreaterThanOrEqual(2);
      expect(a.roles.length).toBeGreaterThanOrEqual(1);
      for (const r of a.roles) {
        expect(a.works).toContain(r.work);
      }
      expect([1, 2, 3]).toContain(a.difficulty);
    }
  });

  it("入门档真实种子可出满 10 题且每题 4 个不重复选项", () => {
    const rounds = buildRounds(seed, {
      difficulty: ActorDifficulty.EASY,
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
