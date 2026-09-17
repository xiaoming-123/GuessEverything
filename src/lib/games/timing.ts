/**
 * 对局计时常量 · 纯逻辑共享（零依赖）
 */

/** 普通题每题作答时限 */
export const ROUND_TIME_MS = 15_000;
/** 谜语题（阅读量大）放宽到 20s */
export const RIDDLE_TIME_MS = 20_000;

/** 物品谜语题题型标识（避免本层反向 import 具体玩法类型） */
export const RIDDLE_TYPE = "GUESS_FROM_RIDDLE";

/** 按题型取每题时限 */
export function getRoundTimeMs(questionType?: string): number {
  return questionType === RIDDLE_TYPE ? RIDDLE_TIME_MS : ROUND_TIME_MS;
}
