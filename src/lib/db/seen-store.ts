/**
 * 玩家「最近出过的题」记忆 · 进程内 LRU
 *
 * 按 playerId + mode 记录最近 N 个素材 key，出题时优先避开。
 * 仅用于体验优化（跨局防重复），丢失可接受：
 * 与内存会话/nonce 同理，多实例部署时需换 Redis。
 */

const MAX_PER_SLOT = 40;

/** key = `${playerId}:${mode}` → 最近素材 key（旧 → 新） */
const store = new Map<string, string[]>();

function slotKey(playerId: string, mode: string): string {
  return `${playerId}:${mode}`;
}

/** 读取最近见过的素材 key（新的在后） */
export function getSeenKeys(playerId: string, mode: string): string[] {
  return store.get(slotKey(playerId, mode)) ?? [];
}

/** 追加一局的素材 key 并截断到最近 MAX_PER_SLOT 个 */
export function markSeenKeys(playerId: string, mode: string, keys: string[]): void {
  const k = slotKey(playerId, mode);
  const prev = store.get(k) ?? [];
  const merged = [...prev, ...keys];
  // 去重（保留最后出现的位置）
  const deduped = [...new Set(merged)];
  store.set(k, deduped.slice(-MAX_PER_SLOT));
}
