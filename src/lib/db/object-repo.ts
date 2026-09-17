/**
 * 物品语料加载
 *
 * 优先读取数据库（ObjectItem 表），数据库不可用或为空时回退到种子语料，
 * 保证本地零配置即可跑通玩法闭环。
 */

import type {
  ObjectCategory,
  ObjectCorpusItem,
} from "@/lib/games/object/types";
import seedJson from "@/lib/data/object-seed.json";
import { isDbAvailable } from "./db-available";
import { prisma } from "./prisma";

const seedCorpus = seedJson as ObjectCorpusItem[];

/** 语料静态不变，进程内缓存一次查询结果（省去每局一次的远程往返） */
let corpusCache: ObjectCorpusItem[] | null = null;

export async function loadObjectCorpus(): Promise<ObjectCorpusItem[]> {
  if (corpusCache) return corpusCache;
  if (!(await isDbAvailable())) return (corpusCache = seedCorpus);
  try {
    const items = await prisma.objectItem.findMany();
    corpusCache =
      items.length === 0
        ? seedCorpus
        : items.map((o) => ({
            id: o.id,
            name: o.name,
            category: o.category as ObjectCategory,
            difficulty: o.difficulty,
            clues: o.clues as unknown as string[],
            ...(o.riddle ? { riddle: o.riddle } : {}),
          }));
  } catch {
    // 表结构未同步等异常时回退种子语料
    corpusCache = seedCorpus;
  }
  return corpusCache;
}
