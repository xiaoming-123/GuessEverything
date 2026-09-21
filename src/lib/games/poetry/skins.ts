/**
 * 诗词升官 · 外观/皮肤系统 · 纯逻辑层（零依赖，P3 详设 §1.3）
 *
 * 产品语义（优化方案 §5.8，Prodigy 原则）：
 * - 皮肤**纯装饰**：不改任何数值/判定/出题，只换立绘资产；
 * - 皮肤绑定 rankId，只有当前官阶 = 绑定 rankId 时可视可穿；
 * - 解锁/装备合法性服务端权威（PlayerSkin / PlayerRank.equippedSkin），
 *   客户端传 key 只做「选择」，裁决在服务端。
 *
 * 本文件零框架依赖：不 import next/*、@prisma/client、react、任何 IO。
 */

/** 解锁方式：ACHIEVEMENT 本期实现；EVENT/EXCHANGE 接口位（本期无实例） */
export type SkinUnlock =
  | { type: "ACHIEVEMENT"; achievementKey: string }
  | { type: "EVENT"; eventId: string }
  | { type: "EXCHANGE"; costExp: number };

export interface SkinSpec {
  /** 稳定 key（勿改，落库 PlayerSkin.skinKey） */
  key: string;
  /** 名称（架空文案） */
  label: string;
  /** 一句话描述（架空文案） */
  desc: string;
  /** 绑定官阶 id（RANKS 口径） */
  rankId: number;
  /** 解锁条件 */
  unlock: SkinUnlock;
}

/** 首批皮肤表（P3-1：1 件皇帝金边龙袍；后续资产 = 生图 + 表行） */
export const SKINS: SkinSpec[] = [
  {
    key: "DRAGON_GOLD",
    label: "龙袍 · 金边织",
    desc: "登极者的礼袍，袖口织入琥珀金边，祥云暗涌。",
    rankId: 10,
    unlock: { type: "ACHIEVEMENT", achievementKey: "EMPEROR" },
  },
];

/** key → 皮肤（客户端渲染文案用） */
export const SKIN_BY_KEY: ReadonlyMap<string, SkinSpec> = new Map(
  SKINS.map((s) => [s.key, s]),
);

/**
 * 结算后按新达成成就评估解锁（纯函数，结算事务内调用）。
 * @param newBadges 本次新达成成就 key（evaluateAchievements 输出）
 * @param ownedKeys 已拥有皮肤 key 集
 * @returns 本次新解锁皮肤 key（保持 SKINS 表序，已拥有的不重复）
 */
export function skinsUnlockedByBadges(newBadges: string[], ownedKeys: string[]): string[] {
  const owned = new Set(ownedKeys);
  const badges = new Set(newBadges);
  const out: string[] = [];
  for (const skin of SKINS) {
    if (owned.has(skin.key)) continue;
    if (skin.unlock.type === "ACHIEVEMENT" && badges.has(skin.unlock.achievementKey)) {
      out.push(skin.key);
    }
  }
  return out;
}

/**
 * 装备合法性（纯函数，服务端裁决）：
 * 拥有 + 皮肤绑定官阶 = 玩家当前官阶。
 * 未知 key 一律拒绝（不泄露皮肤表以外的信息）。
 */
export function canEquipSkin(
  skinKey: string,
  ownedKeys: string[],
  currentRankId: number,
): boolean {
  const spec = SKIN_BY_KEY.get(skinKey);
  if (!spec) return false;
  if (!ownedKeys.includes(skinKey)) return false;
  return spec.rankId === currentRankId;
}
