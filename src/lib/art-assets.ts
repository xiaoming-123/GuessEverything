/**
 * 美术资产常量表（详设 §6 约定：引用统一走本表，D5 只改这张表，组件不动）。
 *
 * D5 前：HERO_AVATARS / NPC_AVATARS 为 emoji 占位；
 * D5 入库后：换成 `/art/q_hero_rank{NN}_{key}.png`、`/art/q_npc_*.png` 路径，
 * 组件层无需改动（组件只认 HERO_AVATARS[rankId] 返回的字符串，
 * 以 `http`/`/` 开头按图片渲染，否则按 emoji 文本渲染）。
 */

import { RANKS } from "@/lib/games/poetry/rank";
import type { PersonaKey } from "@/lib/games/poetry/persona";

/** 各官阶 Q 版主角立绘（D5 前 emoji 占位，D5 后换 `/art/q_hero_rankNN_key.png`） */
export const HERO_AVATARS: Record<number, string> = {
  0: "🧍", // 布衣
  1: "🧑‍🎓", // 童生
  2: "🎓", // 秀才
  3: "🧑‍🏫", // 举人
  4: "👨‍💼", // 贡士
  5: "🎖️", // 进士
  6: "👔", // 翰林
  7: "🧑‍⚖️", // 知府
  8: "🎩", // 侍郎
  9: "🧓", // 丞相
  10: "👑", // 皇帝
};

/** NPC 人设头像（D5 前 emoji 占位，D5 后换 `/art/q_npc_*.png`） */
export const NPC_AVATARS: Record<PersonaKey, string> = {
  TUTOR: "🎓",
  EXAMINER: "📜",
  EMPEROR: "👑",
};

/** 封面（D5 前无资产，占位空串） */
export const COVER_ART = "";

/** 官阶 key 的稳定 slug（D5 文件命名 q_hero_rank01_tongsheng.png 等） */
export function heroAssetKey(rankId: number): string {
  return RANKS[rankId]?.key?.toLowerCase() ?? "unknown";
}
