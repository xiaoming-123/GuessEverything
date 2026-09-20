/**
 * 诗词升官 · 阶段 B 数据层集成测试（临时隔离库）
 *
 * 验收项（docs/design/2026-09-17-poetry-rank-review-and-next.md §阶段B）：
 * - 双开并发不重复：并发开局，已见键零重叠（事务选题 + P2002 换种子重试）
 * - 重启不遗忘：已见记录持久化（重新构建客户端实例后仍可读、仍可排除）
 * - 重复结算不加分：最后一题判题重放 / 并发双开，功名只加一次
 * - 无资格考试被拒绝：功名未达门槛 / 越级科考 / 错位官阶 → 403
 * - 旧存档保留：kind=STAGE 会话不受官阶模式影响，官阶档案默认布衣
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

describe("诗词升官 · 容量不足与旧存档兼容", () => {
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

  it("旧存档保留：STAGE 会话不受官阶模式影响，官阶档案默认布衣", async () => {
    const pid = await makePlayer();
    const legacy = await prisma.gameSession.create({
      data: {
        id: randomUUID(),
        mode: "POETRY",
        stage: "PRIMARY",
        rounds: [
          {
            roundIndex: 0,
            type: "GUESS_POET",
            prompt: "床前明月光",
            options: ["李白", "杜甫", "白居易", "苏轼"],
            answerIndex: 0,
            sourceKey: "legacy:0:GUESS_POET",
            meta: { poemTitle: "静夜思", poet: "李白", dynasty: "唐" },
          },
        ],
        roundCount: 1,
        status: "ACTIVE",
        score: 0,
        expiresAt: new Date(Date.now() + 600_000),
        playerId: pid,
      },
    });
    // 旧会话默认 kind = STAGE（schema 默认值），rankId / settleKey 为空
    const got = await prisma.gameSession.findUnique({ where: { id: legacy.id } });
    expect(got?.kind).toBe("STAGE");
    expect(got?.rankId).toBeNull();
    expect(got?.settleKey).toBeNull();
    // 官阶判题入口拒绝旧会话（404：非 RANKED）
    await expect(
      judgeRankedAnswer({
        gameSessionId: legacy.id,
        roundIndex: 0,
        choice: 0,
        timeMs: 100,
      }),
    ).rejects.toMatchObject({ status: 404 });
    // 官阶档案为布衣默认态（未被旧玩法触碰）
    const view = await getRankView(pid);
    expect(view.rankId).toBe(0);
    expect(view.totalExp).toBe(0);
    expect(view.ranks).toHaveLength(RANKS.length);
    expect(view.ranks[10].isEmperor).toBe(true);
  });
});
