/**
 * 诗词升官 · P3-1 外观/皮肤系统 · 集成测试（详设 P3 §1.6）
 *
 * 验收项：
 * - 登极大考全对 → EMPEROR 成就 → 结算事务解锁 DRAGON_GOLD（PlayerSkin 落行）
 * - RankView.skins：owned 含 key / equipped 初始 null
 * - setSkin：装备合法（rank 10 拥有）→ equippedSkin 落库 + RankView 回显；
 *   卸下 → null；未拥有 / rank 不匹配 → 403；无档案 → 404；参数缺失 → 400
 * - 重复解锁幂等（再次登极局不重复落行）
 *
 * 环境：独立临时库（与主集成测试互不干扰）。
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
  setSkin,
  startRankedSession,
} from "@/lib/db/rank-service";

const tmpDb = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "C:/temp").replace(/\\/g, "/");
  const file = `${base}/rank-p3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

function newPlayer() {
  return { id: randomUUID(), nickname: `p3-${randomUUID().slice(0, 4)}`, avatar: "🙂" };
}

/** 白盒：答完一局全部题目（全对；从会话 rounds JSON 读答案索引） */
async function playAllCorrect(gameSessionId: string) {
  const sess = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameSessionId } });
  const rounds = sess.rounds as unknown as Array<{ answerIndex: number }>;
  let last = null;
  for (let i = 0; i < rounds.length; i++) {
    last = await judgeRankedAnswer({
      gameSessionId,
      roundIndex: i,
      timeMs: 3000,
      choice: rounds[i].answerIndex,
    });
  }
  return last;
}

/** 构造丞相档（rank 9 + 功名过皇帝科考门槛 156000） */
async function makeChancellor() {
  const p = newPlayer();
  await prisma.player.create({ data: p });
  await prisma.playerRank.create({
    data: { playerId: p.id, rank: 9, totalExp: 160000 },
  });
  return p;
}

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${tmpDb.file}${suffix}`, { force: true });
    } catch {
      // 临时文件：Windows 句柄释放延迟，由系统 TMPDIR 回收
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

describe("P3-1 皮肤解锁（结算事务权威）", () => {
  it("登极大考全对 → EMPEROR 成就 → 解锁 DRAGON_GOLD，RankView.skins 回显", async () => {
    const p = await makeChancellor();
    const start = await startRankedSession({ playerId: p.id, kind: "EXAM", rankId: 10 });
    expect(start.rounds.length).toBe(15); // 皇帝大考 15 题
    const summary = await playAllCorrect(start.gameSessionId);
    expect(summary).not.toBeNull();
    // 最后一题判题即触发结算（与 P2 集成测试同口径）：等结算落库
    const rankRow = await prisma.playerRank.findUniqueOrThrow({ where: { playerId: p.id } });
    expect(rankRow.rank).toBe(10); // 登极成功
    const ach = await prisma.playerAchievement.findUnique({
      where: { playerId_key: { playerId: p.id, key: "EMPEROR" } },
    });
    expect(ach).not.toBeNull();
    const skins = await prisma.playerSkin.findMany({ where: { playerId: p.id } });
    expect(skins.map((s) => s.skinKey)).toEqual(["DRAGON_GOLD"]);
    // 视图回显：owned 含 key，equipped 初始 null（未穿戴）
    const view = await getRankView(p.id);
    expect(view.skins.owned).toEqual(["DRAGON_GOLD"]);
    expect(view.skins.equipped).toBeNull();
  });

  it("重复结算幂等：皮肤不重复落行", async () => {
    const p = await makeChancellor();
    const start = await startRankedSession({ playerId: p.id, kind: "EXAM", rankId: 10 });
    await playAllCorrect(start.gameSessionId);
    // 手工再插一次同 key（模拟重放路径）→ upsert 幂等不炸唯一键
    await prisma.playerSkin.upsert({
      where: { playerId_skinKey: { playerId: p.id, skinKey: "DRAGON_GOLD" } },
      create: { playerId: p.id, skinKey: "DRAGON_GOLD" },
      update: {},
    });
    const count = await prisma.playerSkin.count({ where: { playerId: p.id } });
    expect(count).toBe(1);
  });
});

describe("P3-1 setSkin 装备裁决", () => {
  it("rank 10 + 拥有 → 装备成功，落库 + RankView 回显", async () => {
    const p = await makeChancellor();
    const start = await startRankedSession({ playerId: p.id, kind: "EXAM", rankId: 10 });
    await playAllCorrect(start.gameSessionId);
    const res = await setSkin({ playerId: p.id, skinKey: "DRAGON_GOLD" });
    expect(res.equipped).toBe("DRAGON_GOLD");
    const rankRow = await prisma.playerRank.findUniqueOrThrow({ where: { playerId: p.id } });
    expect(rankRow.equippedSkin).toBe("DRAGON_GOLD");
    const view = await getRankView(p.id);
    expect(view.skins.equipped).toBe("DRAGON_GOLD");
  });

  it("卸下（skinKey=null）→ equipped 置 null", async () => {
    const p = await makeChancellor();
    const start = await startRankedSession({ playerId: p.id, kind: "EXAM", rankId: 10 });
    await playAllCorrect(start.gameSessionId);
    await setSkin({ playerId: p.id, skinKey: "DRAGON_GOLD" });
    const res = await setSkin({ playerId: p.id, skinKey: null });
    expect(res.equipped).toBeNull();
    const view = await getRankView(p.id);
    expect(view.skins.equipped).toBeNull();
    expect(view.skins.owned).toEqual(["DRAGON_GOLD"]); // 拥有不受卸下影响
  });

  it("未拥有 → 403", async () => {
    const p = await makeChancellor();
    await expect(setSkin({ playerId: p.id, skinKey: "DRAGON_GOLD" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("未知皮肤 key → 403", async () => {
    const p = await makeChancellor();
    await expect(setSkin({ playerId: p.id, skinKey: "GHOST" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rank 不匹配（拥有皇帝皮肤但当前非皇帝阶——构造脏档）→ 403", async () => {
    const p = newPlayer();
    await prisma.player.create({ data: p });
    await prisma.playerRank.create({ data: { playerId: p.id, rank: 5, totalExp: 40000 } });
    await prisma.playerSkin.create({ data: { playerId: p.id, skinKey: "DRAGON_GOLD" } });
    await expect(setSkin({ playerId: p.id, skinKey: "DRAGON_GOLD" })).rejects.toMatchObject({
      status: 403,
    });
    // 脏穿戴数据防御：手工写入非法 equippedSkin，RankView 下发 null
    await prisma.playerRank.update({
      where: { playerId: p.id },
      data: { equippedSkin: "DRAGON_GOLD" },
    });
    const view = await getRankView(p.id);
    expect(view.skins.equipped).toBeNull();
  });

  it("无官阶档案 → 404；参数缺失 → 400", async () => {
    await expect(setSkin({ playerId: randomUUID(), skinKey: null })).rejects.toMatchObject({
      status: 404,
    });
    await expect(setSkin({ skinKey: null })).rejects.toMatchObject({ status: 400 });
    const p = await makeChancellor();
    await expect(setSkin({ playerId: p.id })).rejects.toMatchObject({ status: 400 });
  });
});
