/**
 * 诗词语料加载
 *
 * 优先读取数据库（Poem 表），数据库不可用或为空时回退到种子语料，
 * 保证本地零配置即可跑通玩法闭环。
 */

import type { PoemCorpusItem } from "@/lib/games/poetry/types";
import seedJson from "@/lib/data/poetry-seed.json";
import { isDbAvailable } from "./db-available";
import { prisma } from "./prisma";

const seedCorpus = seedJson as PoemCorpusItem[];

/** 语料静态不变，进程内缓存一次查询结果（省去每局一次的远程往返） */
let corpusCache: PoemCorpusItem[] | null = null;

export async function loadPoetryCorpus(): Promise<PoemCorpusItem[]> {
  if (corpusCache) return corpusCache;
  if (!(await isDbAvailable())) return (corpusCache = seedCorpus);
  try {
    const poems = await prisma.poem.findMany();
    corpusCache =
      poems.length === 0
        ? seedCorpus
        : poems.map((p) => ({
            id: p.id,
            title: p.title,
            poet: p.poet,
            dynasty: p.dynasty,
            grade: p.grade,
            lines: p.lines as string[],
            famous: p.famous,
          }));
  } catch {
    // 数据库未就绪（本地开发 / CI），回退种子语料
    corpusCache = seedCorpus;
  }
  return corpusCache;
}
