/**
 * 诗词升官 · P3-2 赛季重置与榜单定格 · 集成测试（详设 P3 §2.6）
 *
 * 验收项：
 * - 结算跨赛季（存档 seasonKey ≠ 当前）→ SeasonBoard 定格旧档 + seasonExp 清零重计
 *   + totalExp/rank 常青不动（功名只增不减红线）
 * - 皇榜视图惰性迁移（跨赛季后不结算只开皇榜 → 定格 + 切键）
 * - 重复定格幂等（唯一键 seasonKey+playerId，upsert 不炸）
 * - 当前榜按 seasonExp 排序；LeaderboardView.season/seasonLabel/past 形状
 *
 * 环境：独立临时库（与其他集成测试互不干扰）。
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  judgeRankedAnswer,
  startRankedSession,
} from "@/lib/db/rank-service";
import { getLeaderboardView } from "@/lib/db/leaderboard-service";
import { seasonKeyForDate } from "@/lib/games/poetry/season";

const tmpDb = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "C:/temp").replace(/\\/g, "/");
  const file = `${base}/rank-p3s-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

/** 服务端当前赛季键（与 leaderboard-service.localDate 同口径） */
function currentSeason(): string {
  const dk = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  return seasonKeyForDate(dk);
}

function newPlayer(nick?: string) {
  return {
    id: randomUUID(),
    nickname: nick ?? `p3s-${randomUUID().slice(0, 4)}`,
    avatar: "🙂",
  };
}

/** 一局研习全对（白盒读答案）→ 返回实际入账功名 */
async function playPractice(playerId: string): Promise<number> {
  const view = await startRankedSession({ playerId, kind: "PRACTICE" });
  const sess = await prisma.gameSession.findUniqueOrThrow({
    where: { id: view.gameSessionId },
  });
  const rounds = sess.rounds as unknown as Array<{ answerIndex: number }>;
  let last = null;
  for (let i = 0; i < rounds.length; i++) {
    last = await judgeRankedAnswer({
      gameSessionId: view.gameSessionId,
      roundIndex: i,
      timeMs: 3000,
      choice: rounds[i].answerIndex,
    });
  }
  const row = await prisma.gameSession.findUniqueOrThrow({
    where: { id: view.gameSessionId },
  });
  expect(last).not.toBeNull();
  return row.score;
}

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${tmpDb.file}${suffix}`, { force: true });
    } catch {
      // Windows 句柄释放延迟，由系统 TMPDIR 回收
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

describe("P3-2 结算事务赛季定格", () => {
  it("跨赛季结算：旧档定格 SeasonBoard + seasonExp 清零重计 + totalExp/rank 常青", async () => {
    const p = newPlayer();
    await prisma.player.create({ data: p });
    // 构造上赛季老档：rank 3 / totalExp 15000 / seasonExp 9000 / seasonKey "2020-Q1"
    await prisma.playerRank.create({
      data: { playerId: p.id, rank: 3, totalExp: 15000, seasonKey: "2020-Q1", seasonExp: 9000 },
    });

    const gained = await playPractice(p.id);
    expect(gained).toBeGreaterThan(0);

    // 旧赛季定格：SeasonBoard 落行（含旧 rank/seasonExp）
    const snap = await prisma.seasonBoard.findUnique({
      where: { seasonKey_playerId: { seasonKey: "2020-Q1", playerId: p.id } },
    });
    expect(snap).not.toBeNull();
    expect(snap!.rank).toBe(3);
    expect(snap!.seasonExp).toBe(9000);

    const row = await prisma.playerRank.findUniqueOrThrow({ where: { playerId: p.id } });
    expect(row.seasonKey).toBe(currentSeason());
    // seasonExp 清零后重计 = 本局入账（新玩家档无周奖干扰——weeklyBonusKeys 空）
    expect(row.seasonExp).toBe(gained);
    // 常青：totalExp = 旧 15000 + 本局；rank 不受赛季影响
    expect(row.totalExp).toBe(15000 + gained);
    expect(row.rank).toBe(3);
  });

  it("同赛季结算：不产生定格，seasonExp 累加", async () => {
    const p = newPlayer();
    await prisma.player.create({ data: p });
    const gained = await playPractice(p.id);
    const row = await prisma.playerRank.findUniqueOrThrow({ where: { playerId: p.id } });
    expect(row.seasonKey).toBe(currentSeason());
    expect(row.seasonExp).toBe(gained);
    const snaps = await prisma.seasonBoard.count({ where: { playerId: p.id } });
    expect(snaps).toBe(0);
  });
});

describe("P3-2 皇榜视图惰性迁移", () => {
  it("跨赛季旧档打开皇榜 → 定格 + 切键清零（不结算路径）", async () => {
    const p = newPlayer("旧档甲");
    await prisma.player.create({ data: p });
    await prisma.playerRank.create({
      data: { playerId: p.id, rank: 5, totalExp: 40000, seasonKey: "2021-Q2", seasonExp: 12000 },
    });

    const view = await getLeaderboardView(p.id);
    // 迁移后视图立即反映：season = 当前，my.seasonExp = 0
    expect(view.season).toBe(currentSeason());
    expect(view.seasonLabel).toContain("季度");
    expect(view.my).not.toBeNull();
    expect(view.my!.seasonExp).toBe(0);

    const snap = await prisma.seasonBoard.findUnique({
      where: { seasonKey_playerId: { seasonKey: "2021-Q2", playerId: p.id } },
    });
    expect(snap).not.toBeNull();
    expect(snap!.seasonExp).toBe(12000);

    const row = await prisma.playerRank.findUniqueOrThrow({ where: { playerId: p.id } });
    expect(row.seasonKey).toBe(currentSeason());
    expect(row.seasonExp).toBe(0);
    // 常青不动
    expect(row.totalExp).toBe(40000);
    expect(row.rank).toBe(5);

    // 往期战绩回显（legacy 键之前的定格）
    expect(view.past.length).toBe(1);
    expect(view.past[0].seasonKey).toBe("2021-Q2");
    expect(view.past[0].label).toBe("2021 年第二季度");
    expect(view.past[0].rankLabel).toBe("进士");
  });

  it("重复打开皇榜：定格幂等（不重复落行、不覆盖旧快照）", async () => {
    const p = newPlayer("旧档乙");
    await prisma.player.create({ data: p });
    await prisma.playerRank.create({
      data: { playerId: p.id, rank: 2, totalExp: 6000, seasonKey: "2022-Q3", seasonExp: 5000 },
    });
    await getLeaderboardView(p.id);
    await getLeaderboardView(p.id);
    await getLeaderboardView(p.id);
    const snaps = await prisma.seasonBoard.findMany({ where: { playerId: p.id } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].seasonExp).toBe(5000);
  });

  it("当前榜按 seasonExp 排序：本季高功名压过高官阶低季功名", async () => {
    const low = newPlayer("高官阶低季功");
    const high = newPlayer("低官阶高季功");
    await prisma.player.create({ data: low });
    await prisma.player.create({ data: high });
    await prisma.playerRank.create({
      data: { playerId: low.id, rank: 9, totalExp: 200000, seasonKey: currentSeason(), seasonExp: 50 },
    });
    await prisma.playerRank.create({
      data: { playerId: high.id, rank: 1, totalExp: 3000, seasonKey: currentSeason(), seasonExp: 99999 },
    });
    const view = await getLeaderboardView(high.id);
    const names = view.items.map((e) => e.name);
    expect(names.indexOf("低官阶高季功")).toBe(0); // 榜首
    expect(names.indexOf("低官阶高季功")).toBeLessThan(names.indexOf("高官阶低季功"));
  });
});
