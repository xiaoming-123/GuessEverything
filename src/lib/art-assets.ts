/**
 * 美术资产常量表（详设 §6 约定：引用统一走本表，D5 只改这张表，组件只认返回的字符串）。
 *
 * D5 已入库（public/art/）：
 * - 主角立绘 /art/q_hero_rank{NN}_{key}.png（11 阶）
 * - NPC 立绘 /art/q_npc_{examiner|tutor}.png
 * - 表情 /art/q_expr_{examiner|tutor}_{happy|surprised|sad}.png
 * - 封面 /art/cover_v1.png
 * 组件层约定：字符串以 `/` 开头按 <img> 渲染（见 art-avatar.tsx），否则按 emoji 文本渲染。
 */

import { RANKS } from "@/lib/games/poetry/rank";
import { SKIN_BY_KEY } from "@/lib/games/poetry/skins";
import type { PersonaKey } from "@/lib/games/poetry/persona";

/** 各官阶 Q 版主角立绘（D5：public/art 真实资产） */
export const HERO_AVATARS: Record<number, string> = {
  0: "/art/q_hero_rank00_buyi.png", // 布衣
  1: "/art/q_hero_rank01_tongsheng.png", // 童生
  2: "/art/q_hero_rank02_xiucai.png", // 秀才
  3: "/art/q_hero_rank03_juren.png", // 举人
  4: "/art/q_hero_rank04_gongshi.png", // 贡士
  5: "/art/q_hero_rank05_jinshi.png", // 进士
  6: "/art/q_hero_rank06_hanlin.png", // 翰林
  7: "/art/q_hero_rank07_zhifu.png", // 知府
  8: "/art/q_hero_rank08_shilang.png", // 侍郎
  9: "/art/q_hero_rank09_chengxiang.png", // 丞相
  10: "/art/q_hero_rank10_diwang.png", // 皇帝
};

/** NPC 人设头像（D5：皇帝钦差复用皇帝登极立绘，主考/引路用独立 NPC 立绘） */
export const NPC_AVATARS: Record<PersonaKey, string> = {
  TUTOR: "/art/q_npc_tutor.png",
  EXAMINER: "/art/q_npc_examiner.png",
  EMPEROR: "/art/q_hero_rank10_diwang.png",
};

/** NPC 表情集（D5；normal 复用立绘本体，不单独出图） */
const NPC_KEY: Record<PersonaKey, "tutor" | "examiner" | null> = {
  TUTOR: "tutor",
  EXAMINER: "examiner",
  EMPEROR: null,
};

/** 取人设表情图：无表情图的人设（皇帝钦差）返回 null，调用方回退立绘 */
export function npcExpressionAsset(
  persona: PersonaKey,
  expression: "happy" | "surprised" | "sad",
): string | null {
  const k = NPC_KEY[persona];
  return k ? `/art/q_expr_${k}_${expression}.png` : null;
}

/** 封面（阶段 6：v2 = v1 底图 + 真实字体标题层，scripts/cover-title.py 幂等生成） */
export const COVER_ART = "/art/cover_v2.png";

/** P2 NPC 立绘（详设 P2 方案 §1.2：同窗/内侍/说书人；组件只认本表返回的字符串） */
export type ExtraNpcKey = "CLASSMATE" | "INATTENDANT" | "STORYTELLER";
export const EXTRA_NPC_AVATARS: Record<ExtraNpcKey, string> = {
  CLASSMATE: "/art/q_npc_classmate.png",
  INATTENDANT: "/art/q_npc_inattendant.png",
  STORYTELLER: "/art/q_npc_storyteller.png",
};

/** 官阶 key 的稳定 slug（D5 文件命名 q_hero_rank01_tongsheng.png 等） */
export function heroAssetKey(rankId: number): string {
  return RANKS[rankId]?.key?.toLowerCase() ?? "unknown";
}

/** P3-1 皮肤资产（详设 P3 §1.3：皮肤 key → 立绘路径；组件只认本表返回值） */
export const SKIN_ASSETS: Record<string, string> = {
  DRAGON_GOLD: "/art/q_skin_rank10_gold.png",
};

/**
 * 取当前官阶立绘（P3-1 穿戴渲染唯一入口）：
 * equippedSkinKey 绑定 rankId 匹配且有资产 → 皮肤路径；否则回退默认立绘。
 * 绑定校验冗余做一次（服务端 canEquipSkin 已裁决，此处防脏数据渲染错图）。
 */
export function heroAssetFor(rankId: number, equippedSkinKey: string | null): string {
  if (equippedSkinKey) {
    const spec = SKIN_BY_KEY.get(equippedSkinKey);
    const asset = SKIN_ASSETS[equippedSkinKey];
    if (spec && asset && spec.rankId === rankId) return asset;
  }
  return HERO_AVATARS[rankId] ?? HERO_AVATARS[0];
}
