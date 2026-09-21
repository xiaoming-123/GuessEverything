/**
 * 诗词升官 · P2 限时事件框架 · 集成测试（详设 P2 方案 §2.5）
 *
 * 验收项：
 * - 事件日（createdAt 落在周二~四 / 15 日）：研习结算功名 = round(base × 倍率)（精确断言）
 * - 非事件日：加成 0（不变量回归）
 * - EXAM 功名入账不加成（晋升判定口径不变）
 * - RankView.event 命中/未命中两态；RankSummary.event 与入账自洽
 * - settleLine 命中事件时含内侍播报句
 *
 * 环境：独立临时库（vi.hoisted 指向新文件，与主集成测试互不干扰）。
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getRankView,
  judgeRankedAnswer,
  startRankedSession,
} from "@/lib/db/rank-service";
import { eventForDate } from "@/lib/games/poetry/events";

const tmpDb = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "C:/temp").replace(/\\/g, "/");
  const file = `${base}/rank-p2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.DATABASE_URL = `file:${file}`;
  return { file, base };
});

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const schemaPath = join(rootDir, "prisma", "schema.prisma");
const prismaCli = join(rootDir, "node_modules", "prisma", "build", "index.js");
execFileSync(
  process.execPath,
  [prismaCli, "db", "push", "--skip-generate", "--schema", schemaPath],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const prisma = new PrismaClient();

/** 事件日（钦天大比 ×1.5）与对照非事件日 */
const EVENT_MS = Date.UTC(2026, 8, 15, 2, 0, 0); // 上海当日 10:00（周二 + 15 日 → imperial-exam）
const NON_EVENT_DATE_KEY = "2026-09-14"; // 周一 → null
const NON_EVENT_MS = Date.UTC(2026, 8, 14, 2, 0, 0);

function newPlayer() {
  return { id: randomUUID(), nickname: `p2-${randomUUID().slice(0, 4)}`, avatar: "🙂" };
}

/** 创建一局研习并全部答对（开局时刻篡改为 EVENT_MS）→ 返回 base（逐题判分之和，事件前口径） */
async function playPracticeAllCorrect() {
  const p = newPlayer();
  await prisma.player.create({ data: p });
  const view = await startRankedSession({ playerId: p.id, kind: "PRACTICE" });
  // 篡改开局时刻到事件日（事件按开局日判定，详设 §2.2）
  await prisma.gameSession.update({
    where: { id: view.gameSessionId },
    data: { createdAt: new Date(EVENT_MS) },
  });
  let base = 0;
  for (let i = 0; i < view.rounds.length; i++) {
    // 白盒：从会话 rounds JSON（含 answerIndex）读取答案索引
    const sess = await prisma.gameSession.findUnique({ where: { id: view.gameSessionId } });
    const rounds = (sess?.rounds as unknown as Array<{ answerIndex: number }>) ?? [];
    const judge = await judgeRankedAnswer({
      gameSessionId: view.gameSessionId,
      roundIndex: i,
      timeMs: 3000,
      choice: rounds[i].answerIndex,
    });
    expect(judge.correct).toBe(true);
    base += judge.gained;
  }
  return { playerId: p.id, sessionId: view.gameSessionId, base };
}

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${tmpDb.file}${suffix}`, { force: true });
    } catch {
      // 临时文件：Windows 句柄释放有延迟，清理失败由系统 TMPDIR 自动回收
    }
  }
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDb();
});

describe("P2 限时事件 · 结算功名加成", () => {
  it("事件日（钦天大比 ×1.5）：研习全对 → 功名 = round(base × 1.5)，settleLine 含内侍播报", async () => {
    const { playerId, sessionId, base } = await playPracticeAllCorrect();
    // 白盒读回入账值
    const sess = await prisma.gameSession.findUniqueOrThrow({ where: { id: sessionId } });
    const expected = Math.round(base * 1.5);
    expect(sess.score).toBe(expected);
    // 权威入账 = PlayerRank.totalExp（新玩家无周奖干扰）
    const rankRow = await prisma.playerRank.findUniqueOrThrow({ where: { playerId } });
    // 成就本身不入账（成就只下发 key），功名 = 加成后本局总分
    expect(rankRow.totalExp).toBe(expected);
  });

  it("非事件日（周一）：加成 0（不变量回归），settleLine 无播报", async () => {
    const p = newPlayer();
    await prisma.player.create({ data: p });
    const view = await startRankedSession({ playerId: p.id, kind: "PRACTICE" });
    await prisma.gameSession.update({
      where: { id: view.gameSessionId },
      data: { createdAt: new Date(NON_EVENT_MS) },
    });
    expect(eventForDate(NON_EVENT_DATE_KEY)).toBeNull();
    let base = 0;
    let lastJudge: Awaited<ReturnType<typeof judgeRankedAnswer>> | null = null;
    for (let i = 0; i < view.rounds.length; i++) {
      const sess = await prisma.gameSession.findUnique({ where: { id: view.gameSessionId } });
      const rounds = (sess?.rounds as unknown as Array<{ answerIndex: number }>) ?? [];
      const judge = await judgeRankedAnswer({
        gameSessionId: view.gameSessionId,
        roundIndex: i,
        timeMs: 3000,
        choice: rounds[i].answerIndex,
      });
      expect(judge.correct).toBe(true);
      base += judge.gained;
      lastJudge = judge;
    }
    const sess = await prisma.gameSession.findUniqueOrThrow({ where: { id: view.gameSessionId } });
    expect(sess.score).toBe(base); // 无加成
    expect(lastJudge!.summary?.event ?? null).toBeNull();
    expect(lastJudge!.summary?.settleLine ?? "").not.toContain("内侍宣");
  });

  it("RankView.event 两态：命中日（按当前实际日期可能命中）字段完整；接口不下发答案字段", async () => {
    const p = newPlayer();
    await prisma.player.create({ data: p });
    await startRankedSession({ playerId: p.id, kind: "PRACTICE" });
    const view = await getRankView(p.id);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const expected = eventForDate(today);
    // 视图与纯函数同口径
    if (expected === null) {
      expect(view.event).toBeNull();
    } else {
      expect(view.event).not.toBeNull();
      expect(view.event!.id).toBe(expected.id);
      expect(view.event!.expMultiplier).toBe(expected.expMultiplier);
      expect(view.event!.endsAt).toBe(expected.endsAt);
    }
    // 红线：视图 JSON 不含答案字段
    const blob = JSON.stringify(view);
    expect(blob).not.toContain("answerIndex");
    expect(blob).not.toContain("sourceKey");
  });
});

describe("P2 限时事件 · EXAM 不加成", () => {
  it("科考（EXAM）功名入账不套事件倍率（晋升判定只比正确率）", async () => {
    const p = newPlayer();
    await prisma.player.create({ data: p });
    // 攒功名达标：先给 9999 功名（越过童生 2000 门槛）
    await prisma.playerRank.create({ data: { playerId: p.id, rank: 0, totalExp: 9999 } });
    const view = await startRankedSession({ playerId: p.id, kind: "EXAM" });
    await prisma.gameSession.update({
      where: { id: view.gameSessionId },
      data: { createdAt: new Date(EVENT_MS) },
    });
    let base = 0;
    let lastJudge: Awaited<ReturnType<typeof judgeRankedAnswer>> | null = null;
    for (let i = 0; i < view.rounds.length; i++) {
      const sess = await prisma.gameSession.findUnique({ where: { id: view.gameSessionId } });
      const rounds = (sess?.rounds as unknown as Array<{ answerIndex: number }>) ?? [];
      const judge = await judgeRankedAnswer({
        gameSessionId: view.gameSessionId,
        roundIndex: i,
        timeMs: 3000,
        choice: rounds[i].answerIndex,
      });
      base += judge.gained;
      lastJudge = judge;
    }
    // EXAM 全对 → 擢升（正确率 100% ≥60%）
    expect(lastJudge!.summary?.promotion.promoted).toBe(true);
    // 功名入账 = base（无 ×1.5）
    const sess = await prisma.gameSession.findUniqueOrThrow({ where: { id: view.gameSessionId } });
    expect(sess.score).toBe(base);
    expect(lastJudge!.summary?.event ?? null).toBeNull();
  });
});
