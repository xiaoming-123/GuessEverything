import { describe, expect, it } from "vitest";
import {
  buildRankedRounds,
  faceKey,
  faceKeyOfKey,
  fillCharPrompt,
  materialKey,
  materializeRound,
  roundFaceKey,
} from "@/lib/games/poetry/engine";
import {
  PoetryQuestionType,
  toRoundView,
  type PoemCorpusItem,
} from "@/lib/games/poetry/types";
import {
  DYNASTY_WHITELIST,
  dynastyDistractorPool,
  fillCharPositions,
  isCjkChar,
  mulberry32,
} from "@/lib/games/poetry/distractors";

/** 多朝代多作者语料（≥5 朝代，供 DYNASTY_PICK 语料内干扰 + 白名单补位两用）
 *  grade 双档：rank0 研习窗口 [1,3]（低阶）用 grade 2；rank3 举人研习窗口 [3,7] 用 grade 4。 */
const corpus: PoemCorpusItem[] = [
  { id: "d1", title: "静夜思", poet: "李白", dynasty: "唐", grade: 2, famous: true, lines: ["床前明月光", "疑是地上霜", "举头望明月", "低头思故乡"] },
  { id: "d2", title: "春晓", poet: "孟浩然", dynasty: "唐", grade: 2, famous: true, lines: ["春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少"] },
  { id: "d3", title: "水调歌头", poet: "苏轼", dynasty: "宋", grade: 2, famous: true, lines: ["明月几时有", "把酒问青天", "但愿人长久", "千里共婵娟"] },
  // rank0 研习窗口 [1,3] 补充素材（凑足 10 题基础池）
  { id: "d9", title: "登鹳雀楼", poet: "王之涣", dynasty: "唐", grade: 3, famous: true, lines: ["白日依山尽", "黄河入海流", "欲穷千里目", "更上一层楼"] },
  { id: "d10", title: "江雪", poet: "柳宗元", dynasty: "唐", grade: 3, famous: true, lines: ["千山鸟飞绝", "万径人踪灭", "孤舟蓑笠翁", "独钓寒江雪"] },
  { id: "d11", title: "相思", poet: "王维", dynasty: "唐", grade: 3, famous: true, lines: ["红豆生南国", "春来发几枝", "愿君多采撷", "此物最相思"] },
  { id: "d12", title: "游园", poet: "汤显祖", dynasty: "明", grade: 3, famous: true, lines: ["原来姹紫嫣红开遍", "似这般都付与断井颓垣", "良辰美景奈何天", "赏心乐事谁家院"] },
  { id: "d4", title: "沁园春", poet: "毛泽东", dynasty: "清", grade: 4, famous: true, lines: ["独立寒秋", "湘江北去", "橘子洲头", "看万山红遍"] },
  { id: "d5", title: "长恨歌", poet: "白居易", dynasty: "唐", grade: 4, famous: true, lines: ["在天愿作比翼鸟", "在地愿为连理枝", "天长地久有时尽", "此恨绵绵无绝期"] },
  { id: "d6", title: "天净沙", poet: "马致远", dynasty: "元", grade: 4, famous: true, lines: ["枯藤老树昏鸦", "小桥流水人家", "古道西风瘦马", "夕阳西下断肠人在天涯"] },
  // rank3 窗口 [3,7] 内的补充素材（同朝代/作者池，供新题型干扰项）
  { id: "d7", title: "春望", poet: "杜甫", dynasty: "唐", grade: 4, famous: true, lines: ["国破山河在", "城春草木深", "感时花溅泪", "恨别鸟惊心"] },
  { id: "d8", title: "鹿柴", poet: "王维", dynasty: "唐", grade: 4, famous: true, lines: ["空山不见人", "但闻人语响", "返景入深林", "复照青苔上"] },
];

const P = (id: string, poet: string, dynasty: string, title: string, lines: string[]): PoemCorpusItem =>
  ({ id, title, poet, dynasty, grade: 4, lines, famous: true });

describe("FILL_CHAR 挖字 prompt 与 CJK 判定", () => {
  it("fillCharPrompt 挖指定位为□，其余保留", () => {
    expect(fillCharPrompt("床前明月光", 0)).toBe("□前明月光");
    expect(fillCharPrompt("床前明月光", 2)).toBe("床前□月光");
    expect(fillCharPrompt("床前明月光", 4)).toBe("床前明月□");
  });
  it("isCjkChar 判 CJK 汉字、排除标点/数字/英文", () => {
    expect(isCjkChar("月")).toBe(true);
    expect(isCjkChar("，")).toBe(false);
    expect(isCjkChar("5")).toBe(false);
    expect(isCjkChar("a")).toBe(false);
    expect(isCjkChar("")).toBe(false);
  });
  it("fillCharPositions 返回句中 CJK 字位（单字句 → 空）", () => {
    expect(fillCharPositions("床前明月光")).toEqual([0, 1, 2, 3, 4]);
    expect(fillCharPositions("，")).toEqual([]);
    expect(fillCharPositions("月")).toEqual([]); // 单字句不出题
    expect(fillCharPositions("明月，光")).toEqual([0, 1, 3]); // 逗号不是 CJK
  });
});

describe("materializeRound · FILL_CHAR / DYNASTY_PICK 新题型", () => {
  it("FILL_CHAR：prompt 挖字、correct=被挖字、4 单字选项无重复且含 correct", () => {
    const r = materializeRound(
      PoetryQuestionType.FILL_CHAR,
      corpus[0], // 静夜思「床前明月光」
      0,
      corpus,
      0,
      mulberry32(1),
      true,
      0, // 挖「床」
    );
    expect(r.prompt).toBe("□前明月光");
    expect(r.options).toHaveLength(4);
    expect(new Set(r.options).size).toBe(4);
    expect(r.options[r.answerIndex]).toBe("床");
    // 干扰字 ≠ 被挖字
    expect(r.options.filter((o) => o !== "床")).toHaveLength(3);
    expect(r.meta.pos).toBe(0);
    expect(r.meta.lineIndex).toBe(0);
    expect(r.meta.grade).toBe(2);
    // sourceKey 四段格式
    expect(r.sourceKey).toBe("d1:0:FILL_CHAR:0");
  });
  it("DYNASTY_PICK：prompt=名句、correct=朝代、4 朝代选项含 correct", () => {
    const r = materializeRound(
      PoetryQuestionType.DYNASTY_PICK,
      corpus[2], // 水调歌头（宋）
      0,
      corpus,
      0,
      mulberry32(2),
      true,
    );
    expect(r.options).toHaveLength(4);
    expect(new Set(r.options).size).toBe(4);
    expect(r.options[r.answerIndex]).toBe("宋");
    expect(r.sourceKey).toBe("d3:0:DYNASTY_PICK");
  });
});

describe("dynastyDistractorPool（review A1）", () => {
  it("仅 2 朝代小语料仍可素材化：白名单补位生效", () => {
    // 语料只有 唐/宋，correct=唐 → 语料内干扰仅「宋」，需白名单补 2 个
    const tiny = [P("x1", "李白", "唐", "甲", ["床前明月光", "疑是地上霜"]), P("x2", "孟浩然", "宋", "乙", ["春眠不觉晓", "处处闻啼鸟"])];
    const pool = dynastyDistractorPool(tiny, "唐");
    // 语料内「宋」在前，白名单补（≠唐、≠已列宋）
    expect(pool[0]).toBe("宋");
    expect(pool.length).toBeGreaterThanOrEqual(3);
    expect(pool.every((d) => d !== "唐")).toBe(true);
    // 白名单补位项都必须是真实朝代（白名单成员）
    for (const d of pool) expect(DYNASTY_WHITELIST).toContain(d);
    // 能凑出 3 个 distinct 干扰 → 可素材化
    const r = materializeRound(PoetryQuestionType.DYNASTY_PICK, tiny[0], 0, tiny, 0, mulberry32(3), true);
    expect(r.options).toHaveLength(4);
    expect(new Set(r.options).size).toBe(4);
    expect(r.options[r.answerIndex]).toBe("唐");
  });
  it("≥5 朝代语料：干扰项优先取语料内高频朝代（白名单退居兜底）", () => {
    // 唐×3 / 宋×1 / 元×1 → correct=宋 时，语料内干扰首项=唐（最高频）
    const five = [
      P("y1", "李白", "唐", "a", ["床前明月光", "疑是地上霜"]),
      P("y2", "杜甫", "唐", "b", ["国破山河在", "城春草木深"]),
      P("y3", "王维", "唐", "c", ["空山不见人", "但闻人语响"]),
      P("y4", "苏轼", "宋", "d", ["明月几时有", "把酒问青天"]),
      P("y5", "马致远", "元", "e", ["枯藤老树昏鸦", "小桥流水人家"]),
    ];
    const pool = dynastyDistractorPool(five, "宋");
    expect(pool[0]).toBe("唐"); // 频次最高
  });
});

describe("materialKey / faceKey / faceKeyOfKey 四段往返（review A4）", () => {
  it("FILL_CHAR materialKey 四段（含 pos），faceKey 含 pos 维度", () => {
    const mk = materialKey(corpus[0], 0, PoetryQuestionType.FILL_CHAR, 1);
    expect(mk).toBe("d1:0:FILL_CHAR:1");
    const fk = faceKey(corpus[0], 0, PoetryQuestionType.FILL_CHAR, 1);
    // 同句不同挖字位 → 不同 faceKey
    const fk2 = faceKey(corpus[0], 0, PoetryQuestionType.FILL_CHAR, 2);
    expect(fk).not.toBe(fk2);
    expect(fk).toContain("□");
  });
  it("faceKeyOfKey 四段 key 往返 ≡ faceKey 直算（含冒号 id）", () => {
    // 普通 id
    const mk = materialKey(corpus[0], 1, PoetryQuestionType.FILL_CHAR, 2);
    expect(faceKeyOfKey(corpus, mk)).toBe(faceKey(corpus[0], 1, PoetryQuestionType.FILL_CHAR, 2));
    // 含冒号的 id（id 可含冒号 → 尾部锚定解析）
    const colonItem: PoemCorpusItem = { ...corpus[0], id: "old:poem" };
    const mkColon = materialKey(colonItem, 0, PoetryQuestionType.FILL_CHAR, 3);
    expect(mkColon).toBe("old:poem:0:FILL_CHAR:3");
    expect(faceKeyOfKey([colonItem], mkColon)).toBe(
      faceKey(colonItem, 0, PoetryQuestionType.FILL_CHAR, 3),
    );
    // 三段基础题型往返
    expect(faceKeyOfKey(corpus, materialKey(corpus[1], 0, PoetryQuestionType.GUESS_POET))).toBe(
      faceKey(corpus[1], 0, PoetryQuestionType.GUESS_POET),
    );
  });
  it("faceKeyOfKey 对 DYNASTY_PICK / COMPLETE_NEXT 边界合法", () => {
    expect(faceKeyOfKey(corpus, materialKey(corpus[2], 0, PoetryQuestionType.DYNASTY_PICK))).toBe(
      faceKey(corpus[2], 0, PoetryQuestionType.DYNASTY_PICK),
    );
    // COMPLETE_NEXT 末句（无下一句）→ undefined
    const lastIdx = corpus[0].lines.length - 1;
    expect(faceKeyOfKey(corpus, materialKey(corpus[0], lastIdx, PoetryQuestionType.COMPLETE_NEXT))).toBeUndefined();
  });
});

describe("roundFaceKey（review A4-2：由 round 重构题面）", () => {
  it("roundFaceKey ≡ faceKey 直算（五题型全覆盖）", () => {
    const types = [
      PoetryQuestionType.GUESS_POET,
      PoetryQuestionType.GUESS_TITLE,
      PoetryQuestionType.COMPLETE_NEXT,
      PoetryQuestionType.FILL_CHAR,
      PoetryQuestionType.DYNASTY_PICK,
    ] as const;
    for (const t of types) {
      const pos = t === PoetryQuestionType.FILL_CHAR ? 1 : undefined;
      const r = materializeRound(t, corpus[0], 0, corpus, 0, mulberry32(9), true, pos);
      expect(roundFaceKey(r)).toBe(faceKey(corpus[0], 0, t, pos));
      // 视图剥离 meta，roundFaceKey 不受影响（用完整 round 重构）
      expect(toRoundView(r)).not.toHaveProperty("meta");
      expect(toRoundView(r)).not.toHaveProperty("answerIndex");
    }
  });
});

describe("buildRankedRounds · D3 题型混入", () => {
  it("低阶（rankId<3）仅基础 3 型，不混入 FILL_CHAR/DYNASTY_PICK", () => {
    const res = buildRankedRounds(corpus, { rankId: 0, kind: "PRACTICE", seed: 100 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hasNew = res.rounds.some(
      (r) =>
        r.type === PoetryQuestionType.FILL_CHAR ||
        r.type === PoetryQuestionType.DYNASTY_PICK,
    );
    expect(hasNew).toBe(false);
  });
  it("高阶（rankId>=3）混入新题型且全部 4 选项无重复（seed 确定可复现）", () => {
    const res = buildRankedRounds(corpus, { rankId: 3, kind: "PRACTICE", seed: 2026 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const newTypes = res.rounds.filter(
      (r) => r.type === PoetryQuestionType.FILL_CHAR || r.type === PoetryQuestionType.DYNASTY_PICK,
    );
    expect(newTypes.length).toBeGreaterThan(0); // 30%×2 概率下，足量语料必然混入
    // 每轮恒 4 选项无重复
    for (const r of res.rounds) {
      expect(r.options).toHaveLength(4);
      expect(new Set(r.options).size).toBe(4);
      expect(r.answerIndex).toBeGreaterThanOrEqual(0);
      expect(r.answerIndex).toBeLessThan(4);
      expect(toRoundView(r)).not.toHaveProperty("answerIndex");
    }
    // 可复现：同 seed 两轮逐字一致
    const res2 = buildRankedRounds(corpus, { rankId: 3, kind: "PRACTICE", seed: 2026 });
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.rounds.map((r) => r.sourceKey + "|" + r.prompt)).toEqual(
      res.rounds.map((r) => r.sourceKey + "|" + r.prompt),
    );
  });
  it("新题型已见 sourceKey（四段）经 excludeKeys 严格排除", () => {
    // 先构造一个含 FILL_CHAR 的局，取其 sourceKey
    const res = buildRankedRounds(corpus, { rankId: 3, kind: "PRACTICE", seed: 777 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fill = res.rounds.find((r) => r.type === PoetryQuestionType.FILL_CHAR);
    expect(fill).toBeDefined();
    if (!fill) return;
    const seen = [fill.sourceKey];
    const res2 = buildRankedRounds(corpus, { rankId: 3, kind: "PRACTICE", seed: 777, excludeKeys: seen });
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    // 该 FILL_CHAR sourceKey 不再出现
    expect(res2.rounds.some((r) => r.sourceKey === fill.sourceKey)).toBe(false);
  });
});
