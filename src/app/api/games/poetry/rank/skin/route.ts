import { withCrypto } from "@/lib/crypto/with-crypto";
import { setSkin } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 皮肤装备（P3-1 详设 §1.4）：穿戴/卸下衣冠。
 * 入参 `{ playerId, skinKey }`（skinKey = null 卸下）；出参 `{ equipped }`。
 * 403 未拥有/官阶不匹配；400 参数不完整；404 无官阶档案。
 * 合法性纯服务端裁决（canEquipSkin），客户端只做选择。
 */
export const POST = withCrypto(async (body) => {
  const { playerId, skinKey } = (body ?? {}) as {
    playerId?: string;
    skinKey?: string | null;
  };
  return setSkin({ playerId, skinKey: skinKey ?? null });
});
