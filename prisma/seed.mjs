/**
 * 语料种子导入（幂等）
 *
 * 从 src/lib/data/*-seed.json 同步到 Poem / Actor / ObjectItem 表。
 * 以种子文件的固定 id（p001 / ac-001 / ob-001）做 upsert，可重复执行：
 *   npx prisma db push   # 先建表
 *   npm run db:seed     # 再导数据
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "..", "src", "lib", "data");

const readSeed = (name) =>
  JSON.parse(readFileSync(resolve(dataDir, name), "utf8"));

const poems = readSeed("poetry-seed.json");
const actors = readSeed("actor-seed.json");
const objects = readSeed("object-seed.json");

const prisma = new PrismaClient();

async function main() {
  // 诗词
  for (const p of poems) {
    await prisma.poem.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        title: p.title,
        poet: p.poet,
        dynasty: p.dynasty,
        grade: p.grade,
        lines: p.lines,
        famous: p.famous ?? false,
      },
      update: {
        title: p.title,
        poet: p.poet,
        dynasty: p.dynasty,
        grade: p.grade,
        lines: p.lines,
        famous: p.famous ?? false,
      },
    });
  }

  // 演员
  for (const a of actors) {
    await prisma.actor.upsert({
      where: { id: a.id },
      create: {
        id: a.id,
        name: a.name,
        region: a.region,
        difficulty: a.difficulty,
        works: a.works,
        roles: a.roles,
      },
      update: {
        name: a.name,
        region: a.region,
        difficulty: a.difficulty,
        works: a.works,
        roles: a.roles,
      },
    });
  }

  // 物品
  for (const o of objects) {
    await prisma.objectItem.upsert({
      where: { id: o.id },
      create: {
        id: o.id,
        name: o.name,
        category: o.category,
        difficulty: o.difficulty,
        clues: o.clues,
        riddle: o.riddle ?? null,
      },
      update: {
        name: o.name,
        category: o.category,
        difficulty: o.difficulty,
        clues: o.clues,
        riddle: o.riddle ?? null,
      },
    });
  }

  const [poemCount, actorCount, objectCount] = await Promise.all([
    prisma.poem.count(),
    prisma.actor.count(),
    prisma.objectItem.count(),
  ]);

  console.log("语料导入完成：");
  console.log(`  Poem（诗词）：本次 ${poems.length} 条，表内共 ${poemCount} 条`);
  console.log(`  Actor（演员）：本次 ${actors.length} 条，表内共 ${actorCount} 条`);
  console.log(`  ObjectItem（物品）：本次 ${objects.length} 条，表内共 ${objectCount} 条`);
}

main()
  .catch((err) => {
    console.error("语料导入失败：", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
