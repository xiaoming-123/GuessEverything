/**
 * 关卡体系 · 纯逻辑层（零依赖）
 *
 * 四模式各三关：诗词按学段，演员/物品/飞花令按难度。
 * 通关规则：正确率 ≥60% 通关；60/80/95% 对应 1/2/3 星。
 * 解锁规则：首关默认解锁，通过第 n 关解锁第 n+1 关。
 */

/** 模式标识（与 GameSession.mode 一致） */
export type GameMode = "POETRY" | "ACTOR" | "OBJECT" | "FEIHUA";

/** 各模式关卡顺序（索引即关卡序，index 0 为第 1 关） */
export const STAGE_ORDER: Record<GameMode, string[]> = {
  POETRY: ["PRIMARY", "JUNIOR", "SENIOR"],
  ACTOR: ["EASY", "NORMAL", "HARD"],
  OBJECT: ["EASY", "NORMAL", "HARD"],
  FEIHUA: ["EASY", "NORMAL", "HARD"],
};

/** 通关正确率门槛（百分比） */
export const PASS_ACCURACY = 60;
/** 星级门槛（百分比） */
export const STAR_THRESHOLDS = [60, 80, 95] as const;

/** 关卡中文标签 */
export const STAGE_LABEL: Record<string, string> = {
  PRIMARY: "小学必背",
  JUNIOR: "初中",
  SENIOR: "高中",
  EASY: "入门",
  NORMAL: "进阶",
  HARD: "骨灰",
};

export interface ClearResult {
  passed: boolean;
  stars: number;
}

/** 按正确率判定通关与星级 */
export function judgeClear(accuracyPercent: number): ClearResult {
  const acc = Math.max(0, Math.min(100, Math.round(accuracyPercent)));
  let stars = 0;
  for (const t of STAR_THRESHOLDS) {
    if (acc >= t) stars += 1;
  }
  return { passed: acc >= PASS_ACCURACY, stars };
}

/** 结算摘要（答完最后一题才返回，附在对局响应上） */
export interface SettleSummary {
  correctCount: number;
  totalRounds: number;
  /** 正确率百分比 0-100 */
  accuracy: number;
  stars: number;
  passed: boolean;
  /** 本次是否刷新星级（用于解锁提示） */
  clearedNow: boolean;
}

/** 关卡进度视图（playerId 维度的已有最优） */
export interface StageProgressLike {
  stage: string;
  stars: number;
  bestScore: number;
}

/**
 * 判断某关卡是否已解锁：首关恒解锁；第 n 关需第 n-1 关 passed（stars ≥ 1）
 */
export function isStageUnlocked(
  mode: GameMode,
  stage: string,
  progresses: StageProgressLike[],
): boolean {
  const order = STAGE_ORDER[mode];
  const index = order.indexOf(stage);
  if (index < 0) return false;
  if (index === 0) return true;
  const prevStage = order[index - 1];
  const prev = progresses.find((p) => p.stage === prevStage);
  return (prev?.stars ?? 0) >= 1;
}

/** 结算视图：各关卡摘要（含解锁状态），供前端渲染关卡列表 */
export interface StageSummary extends StageProgressLike {
  stage: string;
  index: number;
  unlocked: boolean;
}

export function summarizeStages(
  mode: GameMode,
  progresses: StageProgressLike[],
): StageSummary[] {
  return STAGE_ORDER[mode].map((stage, index) => {
    const p = progresses.find((x) => x.stage === stage);
    return {
      stage,
      index,
      stars: p?.stars ?? 0,
      bestScore: p?.bestScore ?? 0,
      unlocked: isStageUnlocked(mode, stage, progresses),
    };
  });
}
