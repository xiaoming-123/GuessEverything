/**
 * 演员语料加载
 *
 * 优先读取数据库（Actor 表），数据库不可用或为空时回退到种子语料，
 * 保证本地零配置即可跑通玩法闭环。
 */

import type {
  ActorCorpusItem,
  ActorRegion,
} from "@/lib/games/actor/types";
import seedJson from "@/lib/data/actor-seed.json";
import { isDbAvailable } from "./db-available";
import { prisma } from "./prisma";

const seedCorpus = seedJson as ActorCorpusItem[];

/** 语料静态不变，进程内缓存一次查询结果（省去每局一次的远程往返） */
let corpusCache: ActorCorpusItem[] | null = null;

export async function loadActorCorpus(): Promise<ActorCorpusItem[]> {
  if (corpusCache) return corpusCache;
  if (!(await isDbAvailable())) return (corpusCache = seedCorpus);
  try {
    const actors = await prisma.actor.findMany();
    corpusCache =
      actors.length === 0
        ? seedCorpus
        : actors.map((a) => ({
            id: a.id,
            name: a.name,
            region: a.region as ActorRegion,
            difficulty: a.difficulty,
            works: a.works as unknown as string[],
            roles: a.roles as unknown as ActorCorpusItem["roles"],
          }));
  } catch {
    // 表结构未同步等异常时回退种子语料
    corpusCache = seedCorpus;
  }
  return corpusCache;
}
