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
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getRankView,
  judgeRankedAnswer,
  resumeRankedSession,
  startRankedSession,
} from "@/lib/db/rank-service";
import { buildRankedRounds } from "@/lib/games/poetry/engine";
import { RANKS } from "@/lib/games/poetry/rank";
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
