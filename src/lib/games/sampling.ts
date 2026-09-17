/**
 * 加权抽样 · 纯函数（零依赖）
 *
 * Efraimidis–Spirakis 不放回加权抽样：
 * key = -ln(1 - rand()) / weight，按 key 升序即按权重降序的随机排列。
 * 权重越大越靠前，同权重时退化为均匀洗牌；种子可复现。
 */
export function weightedOrder<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  rand: () => number,
): T[] {
  return items
    .map((item) => {
      const w = Math.max(weightOf(item), 1e-6);
      // rand() 取 (0,1)，避免 log(0)
      const u = Math.min(Math.max(rand(), 1e-9), 1 - 1e-9);
      return { item, key: -Math.log(1 - u) / w };
    })
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
}
