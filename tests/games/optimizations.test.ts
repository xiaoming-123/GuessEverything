import { describe, expect, it } from "vitest";

import { weightedOrder } from "@/lib/games/sampling";
import { getRoundTimeMs, ROUND_TIME_MS, RIDDLE_TIME_MS } from "@/lib/games/timing";
import { buildRounds as buildActorRounds, materialKey as actorKey } from "@/lib/games/actor/engine";
import { buildRounds as buildObjectRounds } from "@/lib/games/object/engine";
import { buildRounds as buildPoetryRounds } from "@/lib/games/poetry/engine";
import { PoetryStage } from "@/lib/games/poetry/types";
import {
  ActorCorpusItem,
  ActorDifficulty,
  ActorQuestionType,
  ActorRegion,
  toRoundView as actorView,
} from "@/lib/games/actor/types";
import {
  ObjectCorpusItem,
  ObjectCategory,
  ObjectDifficulty,
  ObjectQuestionType,
  toRoundView as objectView,
} from "@/lib/games/object/types";
import { computeScore as objectScore } from "@/lib/games/object/score";
import actorSeed from "@/lib/data/actor-seed.json";
import poetrySeed from "@/lib/data/poetry-seed.json";

/* ---------------- 加权抽样 ---------------- */

describe("weightedOrder", () => {
  it("是输入的一个排列（元素不丢不重）", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const out = weightedOrder(items, (x) => x + 0.01, rand);
    expect(out.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it("等权时退化为随机洗牌（覆盖多个种子不报错）", () => {
    const items = ["a", "b", "c", "d"];
    for (let s = 1; s <= 20; s++) {
      let state = s;
      const rand = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const out = weightedOrder(items, () => 1, rand);
      expect(out.slice().sort()).toEqual(items);
    }
  });
});

/* ---------------- 难度加权抽题 ---------------- */

describe("难度加权分布（演员真实语料）", () => {
  const corpus = actorSeed as unknown as ActorCorpusItem[];
  const diffById = new Map(corpus.map((a) => [a.id, a.difficulty]));

  function meanDifficulty(difficulty: ActorDifficulty): number {
    let sum = 0;
    let n = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rounds = buildActorRounds(corpus, { difficulty, count: 10, seed });
      for (const r of rounds) {
        const id = r.sourceKey.split(":")[0];
        sum += diffById.get(id) ?? 1;
        n += 1;
      }
    }
    return sum / n;
  }

  it("骨灰关的平均素材难度显著高于入门关", () => {
    const hard = meanDifficulty(ActorDifficulty.HARD);
    const easy = meanDifficulty(ActorDifficulty.EASY);
    // 语料 11 个 1 档 / 16 个 2 档 / 3 个 3 档；加权后差距应拉开
    expect(hard).toBeGreaterThan(easy + 0.5);
  });
});

/* ---------------- 跨局防重复 ---------------- */

function syntheticActors(): ActorCorpusItem[] {
  // 全部 1 档：保证 EASY 档位（区间 [1,1]）能取到全部语料
  return Array.from({ length: 8 }, (_, i) => ({
    id: `a${i}`,
    name: `演员${i}`,
    region: ActorRegion.MAINLAND,
    difficulty: 1,
    works: [`作品${i}1`, `作品${i}2`, `作品${i}3`],
    roles: [
      { role: `角色${i}1`, work: `作品${i}1` },
      { role: `角色${i}2`, work: `作品${i}2` },
    ],
  }));
}

describe("excludeKeys 跨局防重复", () => {
  const corpus = syntheticActors();
  const types = [
    ActorQuestionType.GUESS_FROM_WORKS,
    ActorQuestionType.GUESS_FROM_ROLES,
    ActorQuestionType.GUESS_WORK,
  ];

  it("优先出未排除素材（足量新鲜题时不含已见 key）", () => {
    // 排除前 6 位演员的全部题型，剩 2 位 ×3 = 6 个新鲜素材
    const excluded = corpus.slice(0, 6).flatMap((a) => types.map((t) => actorKey(a, t)));
    const rounds = buildActorRounds(corpus, {
      difficulty: ActorDifficulty.EASY,
      count: 5,
      seed: 7,
      excludeKeys: excluded,
    });
    expect(rounds).toHaveLength(5);
    expect(rounds.every((r) => !excluded.includes(r.sourceKey))).toBe(true);
  });

  it("全部素材都见过时回退循环旧题，仍可正常开局", () => {
    const all = corpus.flatMap((a) => types.map((t) => actorKey(a, t)));
    const rounds = buildActorRounds(corpus, {
      difficulty: ActorDifficulty.HARD,
      count: 10,
      seed: 9,
      excludeKeys: all,
    });
    expect(rounds.length).toBeGreaterThanOrEqual(5);
  });

  it("sourceKey 不进入客户端视图", () => {
    const rounds = buildActorRounds(corpus, { difficulty: ActorDifficulty.EASY, count: 3, seed: 3 });
    const view = actorView(rounds[0]);
    expect("sourceKey" in view).toBe(false);
    expect(view).not.toHaveProperty("answerIndex");
  });

  it("诗词引擎支持排除且不下发 sourceKey", () => {
    const poems = poetrySeed as unknown as Parameters<typeof buildPoetryRounds>[0];
    const first = buildPoetryRounds(poems, { stage: PoetryStage.PRIMARY, count: 5, seed: 1 });
    const excluded = first.map((r) => r.sourceKey);
    const second = buildPoetryRounds(poems, {
      stage: PoetryStage.PRIMARY,
      count: 5,
      seed: 2,
      excludeKeys: excluded,
    });
    // 小学 20 首语料充足，第二局不应与第一局素材重合
    expect(second.every((r) => !excluded.includes(r.sourceKey))).toBe(true);
  });
});

/* ---------------- 物品线索递进计分 ---------------- */

describe("物品线索扣分", () => {
  it("初始 1 条线索无惩罚，每多一条 -30，保底 20", () => {
    const base = objectScore({ correct: true, combo: 1, timeMs: 20000, revealedClues: 1 }).gained;
    const two = objectScore({ correct: true, combo: 1, timeMs: 20000, revealedClues: 2 }).gained;
    const three = objectScore({ correct: true, combo: 1, timeMs: 20000, revealedClues: 3 }).gained;
    expect(base - two).toBe(30);
    expect(base - three).toBe(60);
    // 高连击 + 多线索时也不低于保底
    const floored = objectScore({ correct: true, combo: 1, timeMs: 20000, revealedClues: 9 }).gained;
    expect(floored).toBe(20);
  });

  it("答错不受线索数影响，仍为 0 分", () => {
    expect(objectScore({ correct: false, combo: 3, timeMs: 1000, revealedClues: 3 }).gained).toBe(0);
  });

  it("sourceKey 不进入物品视图", () => {
    const items: ObjectCorpusItem[] = [
      { id: "o1", name: "物品甲", category: ObjectCategory.DAILY, difficulty: 1, clues: ["线索1", "线索2", "线索3"], riddle: "谜面甲" },
      { id: "o2", name: "物品乙", category: ObjectCategory.DAILY, difficulty: 1, clues: ["线索1", "线索2", "线索3"] },
      { id: "o3", name: "物品丙", category: ObjectCategory.FOOD, difficulty: 1, clues: ["线索1", "线索2", "线索3"] },
      { id: "o4", name: "物品丁", category: ObjectCategory.NATURE, difficulty: 1, clues: ["线索1", "线索2", "线索3"] },
      { id: "o5", name: "物品戊", category: ObjectCategory.PLANT, difficulty: 1, clues: ["线索1", "线索2", "线索3"] },
    ];
    const rounds = buildObjectRounds(items, { difficulty: ObjectDifficulty.EASY, count: 3, seed: 1 });
    expect("sourceKey" in objectView(rounds[0])).toBe(false);
    expect(rounds[0].sourceKey).toContain(":");
  });
});

/* ---------------- 倒计时 ---------------- */

describe("每题时限", () => {
  it("普通题 15s，谜语题 20s", () => {
    expect(getRoundTimeMs("GUESS_POET")).toBe(ROUND_TIME_MS);
    expect(getRoundTimeMs(ObjectQuestionType.GUESS_FROM_CLUES)).toBe(ROUND_TIME_MS);
    expect(getRoundTimeMs(ObjectQuestionType.GUESS_FROM_RIDDLE)).toBe(RIDDLE_TIME_MS);
    expect(getRoundTimeMs()).toBe(ROUND_TIME_MS);
  });
});
