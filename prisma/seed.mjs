/**
 * 语料种子导入（幂等）
 *
 * 从 src/lib/data/poetry-seed.json 同步到 Poem 表。
 * 以种子文件的固定 id（p001）做 upsert，可重复执行：
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

  const poemCount = await prisma.poem.count();

  console.log("语料导入完成：");
  console.log(`  Poem（诗词）：本次 ${poems.length} 条，表内共 ${poemCount} 条`);
}

main()
  .catch((err) => {
    console.error("语料导入失败：", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
