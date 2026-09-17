/**
 * 数据库可用性探测（进程内缓存）
 *
 * 避免每个请求都等待连接超时；各玩法服务共享同一探测结果，
 * DB 不可用时统一回退到内存兜底存储 / 种子语料。
 */

import { prisma } from "./prisma";

let dbAvailable: boolean | null = null;

/**
 * 本地开发开关：.env 设 USE_MEMORY_DB=1（或 true）即强制内存模式，
 * 完全不连远程库（零网络延迟、可离线）；玩家/排行榜等强依赖 DB 的接口返回 503。
 * 切回真实库：删掉该变量（或设为 0）并重启 dev server。
 */
function memoryForced(): boolean {
  const v = process.env.USE_MEMORY_DB;
  return v === "1" || v?.toLowerCase() === "true";
}

export async function isDbAvailable(): Promise<boolean> {
  if (dbAvailable !== null) return dbAvailable;
  if (memoryForced()) {
    dbAvailable = false;
    return false;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
  return dbAvailable;
}
