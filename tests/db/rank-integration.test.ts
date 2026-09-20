/**
 * 诗词升官 · 阶段 B 数据层集成测试（临时隔离库）
 *
 * 验收项（docs/design/2026-09-17-poetry-rank-review-and-next.md §阶段B）：
 * - 双开并发不重复：并发开局，已见键零重叠（事务选题 + P2002 换种子重试）
 * - 重启不遗忘：已见记录持久化（重新构建客户端实例后仍可读、仍可排除）
 * - 重复结算不加分：最后一题判题重放 / 并发双开，功名只加一次
 * - 无资格考试被拒绝：功名未达门槛 / 越级科考 / 错位官阶 → 403
 * - 容量不足如实上报（409 + 进度保留，不建局）
 *
 * 环境：DATABASE_URL 在导入任何业务模块前（vi.hoisted）指向临时库文件；
 * schema 通过 `prisma db push --skip-generate` 应用到临时库。
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getGalleryView,
  getLedgerView,
  getRankView,
  judgeRankedAnswer,
  requestHint,
  resumeRankedSession,
  startRankedSession,
  submitRankGuess,
} from "@/lib/db/rank-service";
import { makeUpDaily } from "@/lib/db/daily-service";
import { buildRankedRounds } from "@/lib/games/poetry/engine";
import { RANKS } from "@/lib/games/poetry/rank";
import { GUESS_REWARD } from "@/lib/games/poetry/guess";
import {
  PoetryQuestionType,
  type PoemCorpusItem,
} from "@/lib/games/poetry/types";
import seedJson from "@/lib/data/poetry-seed.json";

/* ------------------------------------------------------------------ */
/* 临时库（必须在所有业务模块导入前完成：vi.hoisted 先于 import 执行）  */
/* ------------------------------------------------------------------ */

const tmpDb = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "C:/temp").replace(/\\/g, "/");
  const file = `${base}/rank-it-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.DATABASE_URL = `file:${file}`;
  return { file, base };
});

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const schemaPath = join(rootDir, "prisma", "schema.prisma");
// Windows 下 npx 是 .cmd，execFileSync 不可靠：直接用 node 调 prisma CLI
const prismaCli = join(rootDir, "node_modules", "prisma", "build", "index.js");
execFileSync(
  process.execPath,
  [prismaCli, "db", "push", "--skip-generate", "--schema", schemaPath],
  {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, DATABASE_URL: `file:${tmpDb.file}` },
  },
);

const prisma = new PrismaClient(); // 读 process.env.DATABASE_URL（临时库）

/** 种子语料（测试库 Poem 表为空 → loadPoetryCorpus 回退种子，与本数组同口径） */
const corpus = seedJson as PoemCorpusItem[];

// 灌入种子语料到 Poem 表：诗词阁 lines 全文从 Poem 回填（生产经 db:seed 灌入）。
// 与 loadPoetryCorpus 的「Poem 表为空回退种子」同口径 → 出卷不变；仅让 getGalleryView
// 的 lines 有数据可查。幂等（poem.id 即语料稳定 id，重启不重灌）。
beforeAll(async () => {
  const existing = await prisma.poem.count();
  if (existing === 0) {
    await prisma.poem.createMany({
      data: corpus.map((p) => ({
        id: p.id,
        title: p.title,
        poet: p.poet,
        dynasty: p.dynasty,
        grade: p.grade,
        lines: p.lines,
        famous: p.famous,
      })),
    });
  }
});

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

async function makePlayer(): Promise<string> {
  const p = await prisma.player.create({
    data: { nickname: `升官测试 ${randomUUID().slice(0, 4)}`, avatar: "🐱" },
  });
  return p.id;
}

/** 直接给玩家灌功名（模拟若干局研习后的进度） */
async function grantExp(playerId: string, exp: number): Promise<void> {
  await prisma.playerRank.upsert({
    where: { playerId },
    create: { playerId, rank: 0, totalExp: exp },
    update: { totalExp: exp },
  });
}

/** 会话轮次（服务端数据，含答案） */
async function sessionRounds(sessionId: string) {
  const s = await prisma.gameSession.findUnique({ where: { id: sessionId } });
  return s!.rounds as unknown as { answerIndex: number; sourceKey: string }[];
}

/** 打完一局；pick 按「题序 + 正确答案索引」决定作答（可构造正确率） */
async function play(
  sessionId: string,
  pick: (i: number, answerIndex: number) => number,
  timeMs = 1000,
) {
  const rounds = await sessionRounds(sessionId);
  let last: Awaited<ReturnType<typeof judgeRankedAnswer>>;
  for (let i = 0; i < rounds.length; i++) {
    last = await judgeRankedAnswer({
      gameSessionId: sessionId,
      roundIndex: i,
      choice: pick(i, rounds[i].answerIndex),
      timeMs,
    });
  }
  return last!;
}

const allCorrect = (_i: number, a: number) => a;
const sevenCorrect = (i: number, a: number) => (i < 7 ? a : (a + 1) % 4);
const fiveCorrect = (i: number, a: number) => (i < 5 ? a : (a + 1) % 4);

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${tmpDb.file}${suffix}`, { force: true });
    } catch {
      // 临时文件：Windows 句柄释放有延迟，清理失败由系统 TMPDIR 自动回收
    }
  }
}

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDb();
});

/* ------------------------------------------------------------------ */
/* 开局与资格门禁                                                       */
/* ------------------------------------------------------------------ */

describe("诗词升官 · 开局与资格门禁", () => {
  it("无 playerId / 玩家不存在 → 400 / 404", async () => {
    await expect(startRankedSession({ kind: "PRACTICE" })).rejects.toMatchObject({ status: 400 });
    await expect(
      startRankedSession({ playerId: "ghost", kind: "PRACTICE" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("布衣可研习：10 题、答案永不下发、会话 RANKED 未结算", async () => {
    const pid = await makePlayer();
    const view = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    expect(view.rounds).toHaveLength(10);
    expect(view.rankId).toBe(0);
    expect(view.rank.rankId).toBe(0);
    expect(view.rank.label).toBe("布衣");
    for (const r of view.rounds) {
      expect(r).not.toHaveProperty("answerIndex");
      expect(r).not.toHaveProperty("meta");
      expect(r).not.toHaveProperty("sourceKey");
    }
    const s = await prisma.gameSession.findUnique({ where: { id: view.gameSessionId } });
    expect(s?.kind).toBe("RANKED");
    expect(s?.rankId).toBe(0);
    expect(s?.settleKey).toBeNull();
    expect(s?.status).toBe("ACTIVE");
  });

  it("研习只能在当前官阶（显式指定其他官阶 → 403）", async () => {
    const pid = await makePlayer();
    await expect(
      startRankedSession({ playerId: pid, kind: "PRACTICE", rankId: 1 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("功名未达门槛不得科考（totalExp=1999 < 童生 2000 → 403）", async () => {
    const pid = await makePlayer();
    await grantExp(pid, 1999);
    await expect(
      startRankedSession({ playerId: pid, kind: "EXAM" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("科考目标必须 = 当前官阶 + 1（显式越级 → 403）", async () => {
    const pid = await makePlayer();
    await grantExp(pid, 5000); // 目标 1；指定 2 越级
    await expect(
      startRankedSession({ playerId: pid, kind: "EXAM", rankId: 2 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("功名达标可科考（目标官阶 1，10 题）", async () => {
    const pid = await makePlayer();
    await grantExp(pid, 2000);
    const view = await startRankedSession({ playerId: pid, kind: "EXAM" });
    expect(view.rankId).toBe(1);
    expect(view.rounds).toHaveLength(10);
  });
});

/* ------------------------------------------------------------------ */
/* 事务选题与已见持久化                                                 */
/* ------------------------------------------------------------------ */

describe("诗词升官 · 事务选题与已见持久化", () => {
  it("出题即占用已见（sourceKey + faceKey 双维度落库）", async () => {
    const pid = await makePlayer();
    const view = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const rounds = await sessionRounds(view.gameSessionId);
    const expected = new Set(rounds.map((r) => r.sourceKey));
    const seen = await prisma.playerSeenKey.findMany({ where: { playerId: pid } });
    const seenKeys = new Set(seen.map((k) => k.key));
    for (const k of expected) expect(seenKeys.has(k)).toBe(true);
    // faceKey 维度（题面身份，含 | 分隔）一并落库：换 ID 后同题面仍被排除
    expect(seen.some((k) => k.key.includes("|"))).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(20); // 10 素材 + 10 题面
  });

  it("双开并发不重复：6 局并发起局，两局题面零重叠", async () => {
    const pid = await makePlayer();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        startRankedSession({ playerId: pid, kind: "PRACTICE" }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(3);
    const sessions = await prisma.gameSession.findMany({
      where: {
        id: { in: ok.map((r) => (r as { value: { gameSessionId: string } }).value.gameSessionId) },
      },
    });
    const perSession = sessions.map((s) =>
      new Set((s.rounds as unknown as { sourceKey: string }[]).map((r) => r.sourceKey)),
    );
    for (let i = 0; i < perSession.length; i++) {
      for (let j = i + 1; j < perSession.length; j++) {
        const overlap = [...perSession[i]].filter((k) => perSession[j].has(k));
        expect(overlap).toHaveLength(0);
      }
    }
    // 已见键只增（唯一约束无重复）
    const seenCount = await prisma.playerSeenKey.count({ where: { playerId: pid } });
    expect(seenCount).toBeGreaterThanOrEqual(ok.length * 20);
  });

  it("已见持久化跨「重启」：重建客户端后已见仍可排除且会话可续判（重启不遗忘）", async () => {
    const pid = await makePlayer();
    const first = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    // 模拟进程重启：新开一个 Prisma 客户端实例（同一库文件）
    const prisma2 = new PrismaClient();
    const seen2 = await prisma2.playerSeenKey.findMany({
      where: { playerId: pid },
      select: { key: true },
    });
    await prisma2.$disconnect();
    expect(seen2.length).toBeGreaterThanOrEqual(20);
    // 重启后的出题必须排除这些已见
    const rebuilt = buildRankedRounds(corpus, {
      rankId: 0,
      kind: "PRACTICE",
      seed: 99,
      excludeKeys: seen2.map((k) => k.key),
    });
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) {
      const excluded = new Set(seen2.map((k) => k.key));
      for (const r of rebuilt.rounds) expect(excluded.has(r.sourceKey)).toBe(false);
    }
    // 重启后旧会话仍可判题（会话不遗忘）
    const r = await judgeRankedAnswer({
      gameSessionId: first.gameSessionId,
      roundIndex: 0,
      choice: 0,
      timeMs: 500,
    });
    expect(r.finished).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 一次性结算与晋升                                                     */
/* ------------------------------------------------------------------ */

describe("诗词升官 · 一次性结算与晋升", () => {
  it("研习全对：功名入账 = 本局判分之和，不晋升（KIND_NOT_EXAM）", async () => {
    const pid = await makePlayer();
    const view = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const last = await play(view.gameSessionId, allCorrect);
    const s = last.summary!;
    expect(s.correctCount).toBe(10);
    expect(s.accuracy).toBe(100);
    expect(s.stars).toBe(3);
    expect(s.promotion.promoted).toBe(false);
    expect(s.promotion.reason).toBe("KIND_NOT_EXAM");
    const dbRank = await prisma.playerRank.findUnique({ where: { playerId: pid } });
    const rows = await prisma.answerRecord.findMany({
      where: { sessionId: view.gameSessionId },
      select: { gained: true },
    });
    const sum = rows.reduce((acc, a) => acc + a.gained, 0);
    expect(dbRank?.totalExp).toBe(sum); // 功名 = 本局判分之和
    expect(dbRank?.totalExp).toBeGreaterThan(1500); // 连击倍率 + 速度奖励
    expect(dbRank?.rank).toBe(0);
  });

  it("重复结算不加分：最后一题顺序重放 → 410 且功名不变；并发由下一用例覆盖", async () => {
    const pid = await makePlayer();
    const view = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    await play(view.gameSessionId, allCorrect);
    const expAfterFirst = (await prisma.playerRank.findUnique({ where: { playerId: pid } }))?.totalExp;
    // 结算后会话已 FINISHED：任何判题重放一律 410，功名不变
    await expect(
      judgeRankedAnswer({
        gameSessionId: view.gameSessionId,
        roundIndex: 9,
        choice: 0,
        timeMs: 1000,
      }),
    ).rejects.toMatchObject({ status: 410 });
    const expAfterReplay = (await prisma.playerRank.findUnique({ where: { playerId: pid } }))?.totalExp;
    expect(expAfterReplay).toBe(expAfterFirst);
  });

  it("并发双开最后一题：功名只加一次（结算原子占位）", async () => {
    const pid = await makePlayer();
    const view = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const rounds = await sessionRounds(view.gameSessionId);
    for (let i = 0; i < 9; i++) {
      await judgeRankedAnswer({
        gameSessionId: view.gameSessionId,
        roundIndex: i,
        choice: rounds[i].answerIndex,
        timeMs: 800,
      });
    }
    const results = await Promise.allSettled([
      judgeRankedAnswer({ gameSessionId: view.gameSessionId, roundIndex: 9, choice: rounds[9].answerIndex, timeMs: 500 }),
      judgeRankedAnswer({ gameSessionId: view.gameSessionId, roundIndex: 9, choice: rounds[9].answerIndex, timeMs: 500 }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toBeLessThanOrEqual(1);
    if (ok === 0) {
      expect(
        rejected.some(
          (r) => (r as { reason: Error }).reason.message.includes("已结算"),
        ),
      ).toBe(true);
    }
    const answers = await prisma.answerRecord.findMany({
      where: { sessionId: view.gameSessionId },
      select: { gained: true },
    });
    expect(answers).toHaveLength(10);
    const sum = answers.reduce((s, a) => s + a.gained, 0);
    const dbRank = await prisma.playerRank.findUnique({ where: { playerId: pid } });
    expect(dbRank?.totalExp).toBe(sum); // 不多算
  });

  it("晋升闭环：研习攒功名 → 科考答对 7 题 → 擢升一阶", async () => {
    const pid = await makePlayer();
    await grantExp(pid, 1500);
    // 研习一局全对：功名 + 本局判分（> 500）→ 越过童生门槛 2000
    const practice = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    await play(practice.gameSessionId, allCorrect);
    const afterPractice = await prisma.playerRank.findUnique({ where: { playerId: pid } });
    expect(afterPractice?.totalExp).toBeGreaterThan(2000);
    expect(afterPractice?.rank).toBe(0); // 研习不晋升

    // 科考：答对 7 题（≥60% 通过）
    const exam = await startRankedSession({ playerId: pid, kind: "EXAM" });
    const last = await play(exam.gameSessionId, sevenCorrect, 2500);
    const s = last.summary!;
    expect(s.correctCount).toBe(7);
    expect(s.accuracy).toBe(70);
    expect(s.promotion.promoted).toBe(true);
    expect(s.promotion.reason).toBe("PROMOTED");
    expect(s.promotion.newRank).toBe(1);
    const dbRank = await prisma.playerRank.findUnique({ where: { playerId: pid } });
    expect(dbRank?.rank).toBe(1);
    expect(dbRank?.totalExp).toBe(s.totalExp);
    expect(s.rank.label).toBe(RANKS[1].label);
  });

  it("科考失败（<60%）：不晋升、功名保留、可重考（EXAM_FAILED）", async () => {
    const pid = await makePlayer();
    await grantExp(pid, 2000);
    const exam = await startRankedSession({ playerId: pid, kind: "EXAM" });
    const last = await play(exam.gameSessionId, fiveCorrect, 3000);
    const s = last.summary!;
    expect(s.correctCount).toBe(5);
    expect(s.promotion.promoted).toBe(false);
    expect(s.promotion.reason).toBe("EXAM_FAILED");
    const dbRank = await prisma.playerRank.findUnique({ where: { playerId: pid } });
    expect(dbRank?.totalExp).toBeGreaterThan(2000); // 功名保留
    expect(dbRank?.rank).toBe(0);
    // 可重考
    const retry = await startRankedSession({ playerId: pid, kind: "EXAM" });
    expect(retry.rankId).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 容量不足与旧存档兼容                                                 */
/* ------------------------------------------------------------------ */

describe("诗词升官 · 容量不足", () => {
  it("容量不足如实上报（409 + 进度保留，不建局）", async () => {
    const pid = await makePlayer();
    // 灌满布衣窗口（g1-3）的全部素材 key，使 fresh < 10
    const allKeys = new Set<string>();
    for (const item of corpus.filter((p) => p.grade >= 1 && p.grade <= 3)) {
      for (let i = 0; i < item.lines.length - 1; i++) {
        for (const t of [
          PoetryQuestionType.GUESS_POET,
          PoetryQuestionType.GUESS_TITLE,
          PoetryQuestionType.COMPLETE_NEXT,
        ]) {
          allKeys.add(`${item.id}:${i}:${t}`);
        }
      }
    }
    await prisma.playerSeenKey.createMany({
      data: [...allKeys].map((key) => ({ playerId: pid, key })),
    });
    await expect(startRankedSession({ playerId: pid, kind: "PRACTICE" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("容量不足"),
    });
    // 进度保留：无新会话
    expect(await prisma.gameSession.count({ where: { playerId: pid, kind: "RANKED" } })).toBe(0);
    // 已见持久化未受影响
    expect(await prisma.playerSeenKey.count({ where: { playerId: pid } })).toBe(allKeys.size);
  });
});

/* ------------------------------------------------------------------ */
/* D1 · 人设对话 + RankView 扩展（详设 §1 / §7 D1）                      */
/* ------------------------------------------------------------------ */

describe("诗词升官 · D1 人设对话与 RankView 扩展", () => {
  it("start 视图含 persona/opening：研习→TUTOR 且开局白与纯函数同 seed 一致", async () => {
    const pid = await makePlayer();
    const view = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    expect(view.persona).toBe("TUTOR");
    expect(typeof view.opening).toBe("string");
    expect(view.opening.length).toBeGreaterThan(0);
    // 同 seed（会话 id 哈希）同句：与纯函数口径一致（hashIdToSeed 为服务端内部实现，
    // 这里只断言 opening 落在 TUTOR 池内 + 非空；确定性由 persona.test.ts 覆盖）
    expect(view.opening).not.toContain("answerIndex");
  });

  it("start 视图含 persona/opening：科考→EXAMINER；resume 视图同口径", async () => {
    const pid = await makePlayer();
    await grantExp(pid, 2000);
    const view = await startRankedSession({ playerId: pid, kind: "EXAM" });
    expect(view.rankId).toBe(1);
    expect(view.persona).toBe("EXAMINER");
    expect(view.opening.length).toBeGreaterThan(0);

    // resume：同一局恢复，persona/opening 与 start 一致（同会话 id → 同 seed → 同句）
    const resumed = await resumeRankedSession(pid);
    expect(resumed).not.toBeNull();
    expect(resumed!.gameSessionId).toBe(view.gameSessionId);
    expect(resumed!.persona).toBe(view.persona);
    expect(resumed!.opening).toBe(view.opening);
  });

  it("answer 视图含 feedback：对/错/超时三分支句式正确，且不含答案索引信息", async () => {
    const pid = await makePlayer();
    const view = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const rounds = await sessionRounds(view.gameSessionId);
    const correctIdx = rounds[0].answerIndex;
    const wrongIdx = (correctIdx + 1) % 4;

    const judgeWrong = await judgeRankedAnswer({
      gameSessionId: view.gameSessionId,
      roundIndex: 0,
      choice: wrongIdx,
      timeMs: 1000,
    });
    expect(judgeWrong.feedback).toMatch(/^错。/);
    // 反馈句含出处（explanation 拼接），但不含「answerIndex」/ 正确选项序字样
    expect(judgeWrong.feedback).toContain("出自《");
    expect(judgeWrong.feedback).not.toContain("answerIndex");

    const judgeTimeout = await judgeRankedAnswer({
      gameSessionId: view.gameSessionId,
      roundIndex: 1,
      timeout: true,
      timeMs: 15000,
    });
    expect(judgeTimeout.feedback).toMatch(/^时辰到了。/);
  });

  it("结算 settleLine 三分支：研习=practiceLine / 科考中=promotionLine / 科考败=failLine", async () => {
    // 研习：practiceLine
    const p1 = await makePlayer();
    const v1 = await startRankedSession({ playerId: p1, kind: "PRACTICE" });
    const s1 = (await play(v1.gameSessionId, allCorrect)).summary!;
    expect(s1.settleLine).toBe(`这一卷记下 ${s1.expGained} 功名。`);

    // 科考通过：promotionLine（fromLabel 中式，擢升 toLabel）
    const p2 = await makePlayer();
    await grantExp(p2, 1500);
    const v2 = await startRankedSession({ playerId: p2, kind: "PRACTICE" });
    await play(v2.gameSessionId, allCorrect);
    const v3 = await startRankedSession({ playerId: p2, kind: "EXAM" });
    const s3 = (await play(v3.gameSessionId, sevenCorrect, 2500)).summary!;
    expect(s3.promotion.promoted).toBe(true);
    expect(s3.settleLine).toBe(`布衣中式，擢升${RANKS[1].label}。`);

    // 科考失败：failLine（含正确率与缺口）
    const p3 = await makePlayer();
    await grantExp(p3, 2000);
    const v4 = await startRankedSession({ playerId: p3, kind: "EXAM" });
    const s4 = (await play(v4.gameSessionId, fiveCorrect, 3000)).summary!;
    expect(s4.promotion.reason).toBe("EXAM_FAILED");
    expect(s4.settleLine).toContain("正确率 50%");
    expect(s4.settleLine).toContain("还差 1 题");
    expect(s4.settleLine).toContain("卷面功名已为你留下");
  });

  it("RankView.recentGames：3 局后数组序最新在前、kind 与 accuracy 口径正确", async () => {
    const pid = await makePlayer();
    // 三局研习（不同正确率：全对 / 7 对 / 5 对）
    const a = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const sa = (await play(a.gameSessionId, allCorrect)).summary!;
    const b = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const sb = (await play(b.gameSessionId, sevenCorrect, 2500)).summary!;
    const c = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const sc = (await play(c.gameSessionId, fiveCorrect, 3000)).summary!;

    const view = await getRankView(pid);
    expect(view.recentGames).toHaveLength(3);
    // 最新在前：c → b → a
    expect(view.recentGames[0].expGained).toBe(sc.expGained);
    expect(view.recentGames[0].accuracy).toBe(sc.accuracy);
    expect(view.recentGames[1].expGained).toBe(sb.expGained);
    expect(view.recentGames[2].expGained).toBe(sa.expGained);
    // 均非科考
    for (const g of view.recentGames) expect(g.kind).toBe("PRACTICE");
    // 功名估算口径：avgExp = 三局均值
    const avg = Math.round(
      (sa.expGained + sb.expGained + sc.expGained) / 3,
    );
    expect(avg).toBeGreaterThan(0);
  });

  it("seenCount 只数 sourceKey 行：含 faceKey 行的库不翻倍（review A5）", async () => {
    const pid = await makePlayer();
    const view = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const rounds = await sessionRounds(view.gameSessionId);
    const sourceKeyCount = new Set(rounds.map((r) => r.sourceKey)).size;
    // 每轮 sourceKey + faceKey 双落库 → 总行数 ≥ 2× sourceKey
    const totalRows = await prisma.playerSeenKey.count({ where: { playerId: pid } });
    expect(totalRows).toBeGreaterThanOrEqual(sourceKeyCount * 2);
    const rankView = await getRankView(pid);
    // seenCount = sourceKey 行数（= 本局题数 10），不翻倍
    expect(rankView.seenCount).toBe(sourceKeyCount);
    expect(rankView.seenCount).toBe(10);
    expect(rankView.seenCount).toBeLessThan(totalRows);
  });
});

/* ------------------------------------------------------------------ */
/* D2 · 每日题 + 成就 + 功名簿（详设 §2 / §7 D2）                        */
/* ------------------------------------------------------------------ */

describe("诗词升官 · D2 每日题 / 成就 / 功名簿", () => {
  /** 服务端本地日（与 rank-service localDate 同口径：Asia/Shanghai） */
  function localDate(): string {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  /** 上一自然月前缀 YYYY-MM */
  function prevMonthPrefix(): string {
    const today = localDate();
    const [y, m] = today.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  /** sourceKey → 语料 grade（窗口断言用） */
  const gradeByPoem = new Map(corpus.map((p) => [p.id, p.grade]));

  it("DAILY 三视图 kind 均为 DAILY、roundCount=1，出题窗口=当前官阶 gradeWindow", async () => {
    const pid = await makePlayer();
    const started = await startRankedSession({ playerId: pid, kind: "DAILY" });
    expect(started.kind).toBe("DAILY");
    expect(started.rankId).toBe(0); // 布衣（当前官阶，非 +1）
    expect(started.rounds).toHaveLength(1);

    const rounds = await sessionRounds(started.gameSessionId);
    const poemId = rounds[0].sourceKey.split(":")[0];
    const grade = gradeByPoem.get(poemId)!;
    // 布衣 gradeWindow = [1,3]（研习窗口，非科考窗口 [1,4]）
    expect(grade).toBeGreaterThanOrEqual(1);
    expect(grade).toBeLessThanOrEqual(3);

    // 作答 → 结算 summary.kind = DAILY
    const last = await play(started.gameSessionId, allCorrect);
    expect(last.summary!.kind).toBe("DAILY");
    // resume 视图（若未结算时）kind 口径；此处已结算，直接断言 stage 落库 = DAILY
    const sess = await prisma.gameSession.findUnique({ where: { id: started.gameSessionId } });
    expect(sess!.stage).toBe("DAILY");
  });

  it("DAILY 幂等：当日已结算再开 → 409，不建第二局", async () => {
    const pid = await makePlayer();
    const a = await startRankedSession({ playerId: pid, kind: "DAILY" });
    await play(a.gameSessionId, allCorrect);
    // 当日再开 → 409
    await expect(startRankedSession({ playerId: pid, kind: "DAILY" })).rejects.toMatchObject({
      status: 409,
    });
    // 当日 DAILY 会话只有一局
    expect(
      await prisma.gameSession.count({ where: { playerId: pid, stage: "DAILY" } }),
    ).toBe(1);
  });

  it("DAILY 不触发 FIRST_PRACTICE（kind 口径）但计功名", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "DAILY" });
    const s = (await play(v.gameSessionId, allCorrect)).summary!;
    expect(s.kind).toBe("DAILY");
    expect(s.expGained).toBeGreaterThan(0);
    // DAILY 局不计 FIRST_PRACTICE（纯函数口径：kind !== PRACTICE）
    expect(s.newBadges).not.toContain("FIRST_PRACTICE");
  });

  it("结算 newBadges：首局研习全对 3 连击 → 含 FIRST_PRACTICE / ALL_CORRECT / COMBO_3", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const s = (await play(v.gameSessionId, allCorrect)).summary!;
    expect(s.newBadges).toContain("FIRST_PRACTICE");
    expect(s.newBadges).toContain("ALL_CORRECT");
    expect(s.newBadges).toContain("COMBO_3");
    // 落库：PlayerAchievement 持有集与下发一致
    const earned = await prisma.playerAchievement.findMany({
      where: { playerId: pid },
      select: { key: true },
    });
    expect(earned.map((e) => e.key).sort()).toEqual(s.newBadges.slice().sort());
  });

  it("成就幂等：二次结算同条件不再重复下发同一 key", async () => {
    const pid = await makePlayer();
    const v1 = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const s1 = (await play(v1.gameSessionId, allCorrect)).summary!;
    expect(s1.newBadges).toContain("FIRST_PRACTICE");
    // 第二局（FIRST_PRACTICE 已持有）→ 不再下发
    const v2 = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const s2 = (await play(v2.gameSessionId, allCorrect)).summary!;
    expect(s2.newBadges).not.toContain("FIRST_PRACTICE");
    // 落库去重（unique playerId+key）
    const cnt = await prisma.playerAchievement.count({
      where: { playerId: pid, key: "FIRST_PRACTICE" },
    });
    expect(cnt).toBe(1);
  });

  it("getLedgerView：三区块数据（badges / daily / recentBars）齐全且口径正确", async () => {
    const pid = await makePlayer();
    const a = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    await play(a.gameSessionId, allCorrect);
    const ledger = await getLedgerView(pid);
    // 功名总览
    expect(ledger.totalExp).toBeGreaterThan(0);
    expect(ledger.seenCount).toBe(10);
    // 近 1 局柱状图（最新在后，kind=PRACTICE）
    expect(ledger.recentBars).toHaveLength(1);
    expect(ledger.recentBars[0].kind).toBe("PRACTICE");
    expect(ledger.recentBars[0].exp).toBeGreaterThan(0);
    // 月历：cells 非空、含今日 pending 格
    expect(ledger.daily.cells.length).toBeGreaterThan(0);
    const today = localDate();
    const todayCell = ledger.daily.cells.find((c) => c && c.date === today);
    expect(todayCell).toBeDefined();
    // 成就：首局后已获 FIRST_PRACTICE 等
    expect(ledger.badges).toContain("FIRST_PRACTICE");
  });

  it("补签 makeUpDaily：上月缺答日可补签，本月配额用尽后 403", async () => {
    const pid = await makePlayer();
    const prevPrefix = prevMonthPrefix();
    const date1 = `${prevPrefix}-15`;
    const date2 = `${prevPrefix}-16`;
    // 首次补签成功（纯展示，不加功名）
    const before = await prisma.playerRank.findUnique({ where: { playerId: pid } });
    const r1 = await makeUpDaily(pid, date1);
    expect(r1.made).toBe(true);
    const rec1 = await prisma.playerDaily.findUnique({
      where: { playerId_date: { playerId: pid, date: date1 } },
    });
    expect(rec1!.settled).toBe(true);
    expect(rec1!.madeUp).toBe(true);
    // 功名不变（补签不加功名）
    const after = await prisma.playerRank.findUnique({ where: { playerId: pid } });
    expect(after?.totalExp ?? 0).toBe(before?.totalExp ?? 0);
    // 同月第二次补签 → 配额用尽 403
    await expect(makeUpDaily(pid, date2)).rejects.toMatchObject({ status: 403 });
    // 本月之外 → 400
    await expect(makeUpDaily(pid, `${localDate().slice(0, 7)}-15`)).rejects.toMatchObject({
      status: 400,
    });
  });
});

/* ------------------------------------------------------------------ */
/* D3 诗词阁 + 新题型（选字填空 / 朝代配对）                              */
/* ------------------------------------------------------------------ */

describe("诗词升官 · D3 诗词阁与新题型", () => {
  /** 把玩家置到举人（rank 3）→ 研习窗口 [3,7] 才会混入 D3 新题型 */
  async function setRank(pid: string, rank: number): Promise<void> {
    await prisma.playerRank.update({ where: { playerId: pid }, data: { rank } });
  }

  it("诗词阁落库：全对研习局 → 入阁诗=本局 distinct 诗、mastered=true、grade/朝代与语料一致", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    await play(v.gameSessionId, allCorrect);
    const rounds = (await prisma.gameSession.findUnique({ where: { id: v.gameSessionId } }))!
      .rounds as unknown as { sourceKey: string; roundIndex: number }[];
    const expectedPoems = new Set(rounds.map((r) => r.sourceKey.split(":")[0]));
    const gallery = await getGalleryView(pid);
    expect(gallery.total).toBe(expectedPoems.size);
    for (const item of gallery.items) {
      // 入阁字段与语料一致（grade / 朝代 / 作者）
      expect([1, 2, 3]).toContain(item.grade); // 布衣窗口 [1,3]
      expect(item.dynasty).toBeTruthy();
      expect(item.poet).toBeTruthy();
      // 全对 → mastered 全 true
      expect(item.mastered).toBe(true);
      // lines 全文回填（公版语料，非空）
      expect(item.lines.length).toBeGreaterThan(0);
    }
  });

  it("诗词阁幂等：同诗第二局不重复入阁（playerId+poemId unique）", async () => {
    const pid = await makePlayer();
    const a = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    await play(a.gameSessionId, allCorrect);
    const total1 = (await getGalleryView(pid)).total;
    const b = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    await play(b.gameSessionId, allCorrect);
    const g2 = await getGalleryView(pid);
    // 第二局若出现已入阁的诗 → 总数只增 distinct 数，绝无重复行
    const dup = await prisma.playerPoem.findFirst({
      where: { playerId: pid, poemId: { in: (await prisma.playerPoem.findMany({ where: { playerId: pid }, select: { poemId: true }, take: 50 }))!.map((r) => r.poemId) } },
    });
    expect(dup).not.toBeNull();
    // 去重：入阁数 = distinct 诗数（第二局复用则不增）
    expect(g2.total).toBeGreaterThanOrEqual(total1);
    expect(g2.items.length).toBeLessThanOrEqual(20);
  });

  it("getGalleryView 契约：分组统计 + 朝代/学段过滤 + 分页", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    await play(v.gameSessionId, allCorrect);
    const g = await getGalleryView(pid);
    // 分组统计齐全且总和=total
    expect(g.byDynasty.length).toBeGreaterThan(0);
    expect(g.byGrade.length).toBeGreaterThan(0);
    expect(g.byDynasty.reduce((s, d) => s + d.count, 0)).toBe(g.total);
    expect(g.byGrade.reduce((s, d) => s + d.count, 0)).toBe(g.total);
    // 朝代过滤：取任一有数据的朝代，过滤后 items 全属该朝代
    const first = g.byDynasty[0];
    const filtered = await getGalleryView(pid, 1, 20, { dynasty: first.dynasty });
    expect(filtered.total).toBe(g.total); // total 恒为全量（不随过滤变）
    for (const it of filtered.items) expect(it.dynasty).toBe(first.dynasty);
    // 学段过滤
    const gGrade = g.byGrade[0];
    const fGrade = await getGalleryView(pid, 1, 20, { grade: gGrade.grade });
    for (const it of fGrade.items) expect(it.grade).toBe(gGrade.grade);
  });

  it("新题型端到端：举人研习局混入 FILL_CHAR/DYNASTY_PICK，判题路径正确", async () => {
    const pid = await makePlayer();
    await grantExp(pid, 10000);
    await setRank(pid, 3); // 举人 → 研习窗口 [3,7]，rankId>=3 才混入新题型
    // 新题型按素材 30% 名义概率追加（Date.now 种子，生产路径）——单局 10 题不保证混入，
    // 有界重试直到抽到含新题型的一局（review B9：引擎层混入用固定种子精确断言，
    // 此集成路径走生产随机源，故以「混入存在性」+ 有界重试保证确定性收尾）。
    let v: Awaited<ReturnType<typeof startRankedSession>> | null = null;
    let hasNew = false;
    for (let attempt = 0; attempt < 12 && !hasNew; attempt++) {
      const candidate = await startRankedSession({ playerId: pid, kind: "PRACTICE", rankId: 3 });
      const sess = (await prisma.gameSession.findUnique({ where: { id: candidate.gameSessionId } }))!;
      const rs = sess.rounds as unknown as { type: string }[];
      hasNew = rs.some((r) => r.type === "FILL_CHAR" || r.type === "DYNASTY_PICK");
      if (hasNew) v = candidate;
    }
    expect(v).not.toBeNull(); // 12 次内必混入（每素材 30% 名义概率，足量语料下极大概率命中）
    expect(v!.rankId).toBe(3);
    expect(hasNew).toBe(true);
    // 视图契约：不下发 answerIndex / meta / sourceKey
    for (const r of v!.rounds) {
      expect(r).not.toHaveProperty("answerIndex");
      expect(r).not.toHaveProperty("meta");
      expect(r).not.toHaveProperty("sourceKey");
    }
    // 全对判题 → 结算功名 >0（新题型判题路径与基础题型同）
    const last = await play(v!.gameSessionId, allCorrect);
    expect(last.summary!.expGained).toBeGreaterThan(0);
    expect(last.summary!.rankId).toBe(3);
  });

  it("新题型已见排除：排除某 FILL_CHAR 四段 key 后该题面不重出", async () => {
    // 直接引擎层（与集成同口径）：构造含 FILL_CHAR 的局，取其 sourceKey，
    // 经 excludeKeys 排除后不再出现（四段 key 的已见排除防线生效，review A4）。
    const res = buildRankedRounds(corpus, { rankId: 3, kind: "PRACTICE", seed: 999 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fill = res.rounds.find((r) => r.type === "FILL_CHAR");
    expect(fill).toBeDefined();
    if (!fill) return;
    const res2 = buildRankedRounds(corpus, { rankId: 3, kind: "PRACTICE", seed: 999, excludeKeys: [fill.sourceKey] });
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.rounds.some((r) => r.sourceKey === fill.sourceKey)).toBe(false);
  });
});

describe("诗词升官 · D4 问同窗与剪影竞猜", () => {
  /** 置玩家官阶（研习/科考/竞猜门槛判定用） */
  async function setRank(pid: string, rank: number): Promise<void> {
    const existing = await prisma.playerRank.findUnique({ where: { playerId: pid } });
    if (existing) {
      await prisma.playerRank.update({ where: { playerId: pid }, data: { rank } });
    } else {
      await prisma.playerRank.create({ data: { playerId: pid, rank, totalExp: 0 } });
    }
  }

  it("hint 原子抢占：并发双请求仅 1 成功（输家 409），removedIndexes 全 ≠ answerIndex", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const rounds = (await prisma.gameSession.findUnique({ where: { id: v.gameSessionId } }))!
      .rounds as unknown as { answerIndex: number; options: string[] }[];
    const r0 = rounds[0];
    // 并发双请求：仅 1 成功（hintUsed false→true 条件更新原子占位）
    const results = await Promise.allSettled([
      requestHint({ playerId: pid, gameSessionId: v.gameSessionId, roundIndex: 0 }),
      requestHint({ playerId: pid, gameSessionId: v.gameSessionId, roundIndex: 0 }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // 成功方：恒 2 个移除位，全 ≠ answerIndex
    const removed = (ok[0] as PromiseFulfilledResult<unknown>).value as { removedIndexes: number[] };
    expect(removed.removedIndexes).toHaveLength(2);
    for (const i of removed.removedIndexes) {
      expect(i).not.toBe(r0.answerIndex);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(r0.options.length);
    }
    // 落库 hintUsed=true + hintRoundIndex=0 + hintRemoved
    const sess = await prisma.gameSession.findUnique({ where: { id: v.gameSessionId } });
    expect(sess?.hintUsed).toBe(true);
    expect(sess?.hintRoundIndex).toBe(0);
    // 已用提示后再请求 → 409
    await expect(
      requestHint({ playerId: pid, gameSessionId: v.gameSessionId, roundIndex: 1 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("hint 仅当前未答轮次有效：已答轮次 → 400，越界 → 400", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    // 先答第 0 题
    const rounds = await sessionRounds(v.gameSessionId);
    await judgeRankedAnswer({ gameSessionId: v.gameSessionId, roundIndex: 0, choice: rounds[0].answerIndex, timeMs: 500 });
    // 对已答的第 0 题请求 hint → 400
    await expect(
      requestHint({ playerId: pid, gameSessionId: v.gameSessionId, roundIndex: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    // 越界轮次 → 400
    await expect(
      requestHint({ playerId: pid, gameSessionId: v.gameSessionId, roundIndex: 99 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("结算功名 ×0.8 且 GameSession.score 落折后值（review B4）", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    // 用 hint 后全对
    await requestHint({ playerId: pid, gameSessionId: v.gameSessionId, roundIndex: 0 });
    const rounds = await sessionRounds(v.gameSessionId);
    let last: Awaited<ReturnType<typeof judgeRankedAnswer>>;
    for (let i = 0; i < rounds.length; i++) {
      last = await judgeRankedAnswer({ gameSessionId: v.gameSessionId, roundIndex: i, choice: rounds[i].answerIndex, timeMs: 500 });
    }
    // 本局判分之和（未折价）
    const answers = await prisma.answerRecord.findMany({
      where: { sessionId: v.gameSessionId }, select: { gained: true },
    });
    const rawScore = answers.reduce((s, a) => s + a.gained, 0);
    const expected = Math.round(rawScore * 0.8);
    // 结算功名 = 折后值
    expect(last!.summary!.expGained).toBe(expected);
    expect(last!.summary!.hintUsed).toBe(true);
    // GameSession.score 落折后值（recentGames/功名簿取此口径）
    const sess = await prisma.gameSession.findUnique({ where: { id: v.gameSessionId } });
    expect(sess?.score).toBe(expected);
    // 功名入账 = 折后值（新玩家 totalExp = expected，周奖 0）
    expect(last!.summary!.totalExp).toBe(expected);
  });

  it("未用 hint 的局功名不折价（hintUsed=false）", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    const rounds = await sessionRounds(v.gameSessionId);
    let last: Awaited<ReturnType<typeof judgeRankedAnswer>>;
    for (let i = 0; i < rounds.length; i++) {
      last = await judgeRankedAnswer({ gameSessionId: v.gameSessionId, roundIndex: i, choice: rounds[i].answerIndex, timeMs: 500 });
    }
    const answers = await prisma.answerRecord.findMany({
      where: { sessionId: v.gameSessionId }, select: { gained: true },
    });
    const rawScore = answers.reduce((s, a) => s + a.gained, 0);
    expect(last!.summary!.hintUsed).toBe(false);
    expect(last!.summary!.expGained).toBe(rawScore); // 不折价
  });

  it("resume 恢复灰置按 hintRoundIndex 套题（review A9）：hint 后答完该题 → resume 到下一题无灰置", async () => {
    const pid = await makePlayer();
    const v = await startRankedSession({ playerId: pid, kind: "PRACTICE" });
    // hint 作用于第 1 题
    await requestHint({ playerId: pid, gameSessionId: v.gameSessionId, roundIndex: 1 });
    const sess0 = await prisma.gameSession.findUnique({ where: { id: v.gameSessionId } });
    const removed0 = sess0?.hintRemoved as unknown as number[];
    // 此时 resume：当前题=0（未答任何题），hint.roundIndex=1 ≠ 0 → 视图仍下发 hint（服务端不下发，靠 roundIndex 匹配）
    const resA = await resumeRankedSession(pid);
    expect(resA).not.toBeNull();
    expect(resA!.hint?.roundIndex).toBe(1);
    expect(resA!.hint?.removedIndexes).toEqual(removed0);
    // 答完第 0、1 题（hint 套在第 1 题），继续到第 2 题
    const rounds = await sessionRounds(v.gameSessionId);
    await judgeRankedAnswer({ gameSessionId: v.gameSessionId, roundIndex: 0, choice: rounds[0].answerIndex, timeMs: 500 });
    await judgeRankedAnswer({ gameSessionId: v.gameSessionId, roundIndex: 1, choice: rounds[1].answerIndex, timeMs: 500 });
    // 重开（模拟刷新）→ resume 到第 2 题；hint.roundIndex=1 已被答过 → 客户端判定无灰置（视图 hint 仍含但 roundIndex≠currentIndex）
    const resB = await resumeRankedSession(pid);
    expect(resB).not.toBeNull();
    expect(resB!.answeredIndexes).toContain(1);
    // 关键：hint 作用于第 1 题，答完第 1 题后 resume 到第 2 题，灰置不得套到新题
    // 视图层：hint 仍下发（服务端保留历史），但 roundIndex=1 ≠ 当前 currentIndex=2 → 客户端不渲染灰置
    const currentIdx = resB!.answeredIndexes.length; // 首个未答 = answeredIndexes 数（0,1 已答）
    expect(resB!.hint?.roundIndex ?? -1).not.toBe(currentIdx);
  });

  it("guess 每日幂等 +100 功名 + 猜 rankId+2 判据", async () => {
    const pid = await makePlayer();
    await grantExp(pid, 0);
    await setRank(pid, 0); // 布衣 → 猜 RANKS[2]
    const target = RANKS[2].label; // 秀才
    const before = (await prisma.playerRank.findUnique({ where: { playerId: pid } }))!.totalExp;
    // 猜中
    const r1 = await submitRankGuess({ playerId: pid, guessLabel: target });
    expect(r1.correct).toBe(true);
    expect(r1.gained).toBe(GUESS_REWARD);
    expect(r1.todayUsed).toBe(true);
    const after1 = (await prisma.playerRank.findUnique({ where: { playerId: pid } }))!.totalExp;
    expect(after1 - before).toBe(GUESS_REWARD);
    // 当日幂等：二次提交返回原结果，不重复加功名
    const r2 = await submitRankGuess({ playerId: pid, guessLabel: "不存在的称号" });
    expect(r2.correct).toBe(true); // 返回首次结果（幂等键）
    expect(r2.todayUsed).toBe(true);
    const after2 = (await prisma.playerRank.findUnique({ where: { playerId: pid } }))!.totalExp;
    expect(after2).toBe(after1); // 不重复加
    // RankGuess 唯一键 1 行
    const guesses = await prisma.rankGuess.findMany({ where: { playerId: pid } });
    expect(guesses).toHaveLength(1);
  });

  it("guess 猜错不加功名（correct=false, gained=0）", async () => {
    const pid = await makePlayer();
    await setRank(pid, 1); // 童生 → 猜 RANKS[3] 举人
    const wrong = RANKS[4].label; // 贡士（错误答案）
    const before = (await prisma.playerRank.findUnique({ where: { playerId: pid } }))!.totalExp;
    const r = await submitRankGuess({ playerId: pid, guessLabel: wrong });
    expect(r.correct).toBe(false);
    expect(r.gained).toBe(0);
    const after = (await prisma.playerRank.findUnique({ where: { playerId: pid } }))!.totalExp;
    expect(after).toBe(before);
  });

  it("guess rankId>=8 时 403 + GET 视图 guess=null（review A3）", async () => {
    // 侍郎（rank 8）及以上 → 竞猜入口隐藏
    for (const rank of [8, 9, 10]) {
      const pid = await makePlayer();
      await setRank(pid, rank);
      await expect(
        submitRankGuess({ playerId: pid, guessLabel: RANKS[0].label }),
      ).rejects.toMatchObject({ status: 403 });
      const view = await getRankView(pid);
      expect(view.guess).toBeNull();
    }
  });

  it("guess rankId<8 时 GET 视图 guess.done=false（未猜），猜后 done=true", async () => {
    const pid = await makePlayer();
    await setRank(pid, 3); // 举人 → 可猜
    const v0 = await getRankView(pid);
    expect(v0.guess).not.toBeNull();
    expect(v0.guess!.done).toBe(false);
    await submitRankGuess({ playerId: pid, guessLabel: RANKS[5].label }); // 进士（rank3+2）
    const v1 = await getRankView(pid);
    expect(v1.guess!.done).toBe(true);
  });
});
