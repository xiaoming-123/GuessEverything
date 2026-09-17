import { describe, expect, it } from "vitest";
import { buildRounds, filterByStage, pickQuote } from "@/lib/games/poetry/engine";
import {
  PoetryQuestionType,
  PoetryStage,
  type PoemCorpusItem,
  toRoundView,
} from "@/lib/games/poetry/types";

const corpus: PoemCorpusItem[] = [
  {
    id: "a1",
    title: "静夜思",
    poet: "李白",
    dynasty: "唐",
    grade: 1,
    famous: true,
    lines: ["床前明月光", "疑是地上霜", "举头望明月", "低头思故乡"],
  },
  {
    id: "a2",
    title: "春晓",
    poet: "孟浩然",
    dynasty: "唐",
    grade: 1,
    famous: true,
    lines: ["春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少"],
  },
  {
    id: "a3",
    title: "水调歌头",
    poet: "苏轼",
    dynasty: "宋",
    grade: 9,
    famous: true,
    lines: ["明月几时有", "把酒问青天", "但愿人长久", "千里共婵娟"],
  },
  {
    id: "a4",
    title: "登高",
    poet: "杜甫",
    dynasty: "唐",
    grade: 11,
    famous: true,
    lines: ["无边落木萧萧下", "不尽长江滚滚来"],
  },
  {
    id: "a5",
    title: "山居秋暝",
    poet: "王维",
    dynasty: "唐",
    grade: 10,
    famous: true,
    lines: ["空山新雨后", "天气晚来秋", "明月松间照", "清泉石上流"],
  },
];

describe("filterByStage", () => {
  it("按学段过滤语料", () => {
    const scoped = filterByStage(corpus, PoetryStage.SENIOR);
    expect(scoped.map((p) => p.id)).toEqual(["a4", "a5"]);
  });

  it("学段无语料时回退全量", () => {
    const empty: PoemCorpusItem[] = [corpus[2]]; // 只有 grade 9
    expect(filterByStage(empty, PoetryStage.PRIMARY)).toHaveLength(1);
  });
});

describe("buildRounds", () => {
  it("生成指定数量的轮次且轮次编号连续", () => {
    const rounds = buildRounds(corpus, { stage: PoetryStage.JUNIOR, count: 5, seed: 42 });
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds.length).toBeLessThanOrEqual(5);
    rounds.forEach((r, i) => expect(r.roundIndex).toBe(i));
  });

  it("同种子结果可复现", () => {
    const a = buildRounds(corpus, { stage: PoetryStage.PRIMARY, count: 6, seed: 7 });
    const b = buildRounds(corpus, { stage: PoetryStage.PRIMARY, count: 6, seed: 7 });
    expect(b).toEqual(a);
  });

  it("每轮 4 个选项、答案索引指向正确答案", () => {
    const rounds = buildRounds(corpus, { stage: PoetryStage.PRIMARY, count: 8, seed: 1 });
    for (const r of rounds) {
      expect(r.options).toHaveLength(4);
      expect(new Set(r.options).size).toBe(4);
      expect(r.answerIndex).toBeGreaterThanOrEqual(0);
      expect(r.answerIndex).toBeLessThan(4);
    }
  });

  it("猜诗人题型：答案选项为该诗作者", () => {
    const rounds = buildRounds(corpus, { stage: PoetryStage.PRIMARY, count: 20, seed: 3 });
    const poetRounds = rounds.filter((r) => r.type === PoetryQuestionType.GUESS_POET);
    expect(poetRounds.length).toBeGreaterThan(0);
    for (const r of poetRounds) {
      expect(r.options[r.answerIndex]).toBe(r.meta.poet);
    }
  });

  it("补下句题型：meta 携带 nextLine", () => {
    const rounds = buildRounds(corpus, { stage: PoetryStage.PRIMARY, count: 20, seed: 3 });
    const complete = rounds.filter((r) => r.type === PoetryQuestionType.COMPLETE_NEXT);
    expect(complete.length).toBeGreaterThan(0);
    for (const r of complete) {
      expect(r.meta.nextLine).toBe(r.options[r.answerIndex]);
    }
  });

  it("toRoundView 剥离答案", () => {
    const rounds = buildRounds(corpus, { stage: PoetryStage.PRIMARY, count: 3, seed: 9 });
    const view = toRoundView(rounds[0]);
    expect(view).not.toHaveProperty("answerIndex");
    expect(view).not.toHaveProperty("meta");
    expect(Object.keys(view).sort()).toEqual(["options", "prompt", "roundIndex", "type"]);
  });
});

describe("pickQuote", () => {
  it("两联拼接为名句", () => {
    expect(pickQuote(corpus[0], 0)).toBe("床前明月光，疑是地上霜");
  });
});
