/**
 * 诗词升官 · 晋升判定 · 纯逻辑层（零依赖）
 *
 * 核心规则（红线，见 review 任务书）：
 * - 功名（totalExp）只增不减，失败 / 弃局不扣功名（保留进度）。
 * - **只有科考（EXAM）通过、且考试目标恰好是「当前官阶 + 1」** 才擢升。
 *   - 研习 / 每日题（PRACTICE / DAILY）永不晋升。
 *   - 考试目标不是下一阶（试图越级）→ 不晋升。
 *   - 功名未达下一官阶门槛 → 不晋升（经验不足不能升）。
 *   - 科考未通过（正确率 < 60%）→ 不晋升，功名保留（失败保留经验）。
 * - 皇帝（登极 Boss）是终点：已是皇帝不再晋升（最高阶 / 皇帝一致）。
 * - **题库耗尽不自动晋升**：晋升只能由「通过科考」触发，绝不因题量不足而自动跳阶。
 *
 * 本判定是纯函数：输入「结算时点」的功名 / 官阶 / 本局结果，输出「是否擢升 + 新官阶 + 进度」。
 * 服务端在判题结算时调用；本文件不 import 任何框架 / IO。
 */

import {
  canTakeExam,
  expRequiredForNextExam,
  isRankId,
  nextRank,
} from "./rank";
import type { RankKind } from "./types";

/** 晋升判定的结算原因（互斥，便于上层 UI / 测试断言） */
export type PromotionReason =
  | "PROMOTED" // 擢升成功
  | "ALREADY_EMPEROR" // 已是皇帝（终点）
  | "KIND_NOT_EXAM" // 本局非科考（研习 / 每日题不晋升）
  | "EXAM_TARGET_NOT_NEXT" // 考试目标不是「当前官阶 + 1」（越级 / 错位）
  | "EXP_INSUFFICIENT" // 功名未达下一官阶门槛（经验不足不能升）
  | "EXAM_FAILED"; // 科考未通过（功名保留，可重考）

export interface PromotionInput {
  /** 结算前的当前官阶 id */
  currentRank: number;
  /** 结算后的累计功名（含本局得分，单调不减） */
  totalExp: number;
  /** 本局类型 */
  kind: RankKind;
  /** 本局正确率是否达到通关线（judgeClear().passed，≥60%） */
  examPassed: boolean;
  /** 本局「要晋升到」的目标官阶 id（科考时 = 玩家当前官阶 + 1 才合法） */
  examRank: number;
}

export interface PromotionResult {
  /** 是否擢升 */
  promoted: boolean;
  /** 结算后的官阶 id（promoted 时为 currentRank + 1，否则不变） */
  newRank: number;
  /** 结算后，距「下一场科考功名门槛」还差多少功名（≥0；已是皇帝恒 0） */
  expToNext: number;
  /** 结算后，功名是否已解锁下一场科考（已是皇帝恒 false） */
  nextUnlocked: boolean;
  /** 结算原因（互斥） */
  reason: PromotionReason;
}

/**
 * 晋升判定主入口。
 *
 * 注意：本函数不修改功名（功名由调用方在结算时单调累加后传入 totalExp）；
 * 它只回答「是否擢升 + 新官阶 + 下一场科考进度」。
 */
export function evaluatePromotion(input: PromotionInput): PromotionResult {
  const { currentRank, totalExp, kind, examPassed, examRank } = input;
  if (!isRankId(currentRank)) throw new RangeError(`非法当前官阶: ${currentRank}`);
  if (!Number.isSafeInteger(totalExp) || totalExp < 0) throw new RangeError("功名必须是非负安全整数");

  // 结算后的进度（基于「结果官阶」前瞻，便于 UI 直接展示）
  const forward = (rank: number): Pick<PromotionResult, "expToNext" | "nextUnlocked"> => {
    if (!nextRank(rank)) return { expToNext: 0, nextUnlocked: false };
    const required = expRequiredForNextExam(rank);
    return {
      expToNext: Math.max(0, required - totalExp),
      nextUnlocked: canTakeExam(rank, totalExp),
    };
  };

  // 已是皇帝（终点）：不再晋升
  if (!nextRank(currentRank)) {
    return { promoted: false, newRank: currentRank, ...forward(currentRank), reason: "ALREADY_EMPEROR" };
  }

  // 研习 / 每日题不晋升
  if (kind !== "EXAM") {
    return { promoted: false, newRank: currentRank, ...forward(currentRank), reason: "KIND_NOT_EXAM" };
  }

  // 考试目标必须是「当前官阶 + 1」（越级 / 错位一律拒绝）
  if (examRank !== currentRank + 1) {
    return { promoted: false, newRank: currentRank, ...forward(currentRank), reason: "EXAM_TARGET_NOT_NEXT" };
  }

  // 功名未达下一官阶门槛（经验不足不能升）
  if (!canTakeExam(currentRank, totalExp)) {
    return { promoted: false, newRank: currentRank, ...forward(currentRank), reason: "EXP_INSUFFICIENT" };
  }

  // 科考未通过：功名保留，不降级，可重考
  if (!examPassed) {
    return { promoted: false, newRank: currentRank, ...forward(currentRank), reason: "EXAM_FAILED" };
  }

  // 擢升成功
  const newRank = currentRank + 1;
  return { promoted: true, newRank, ...forward(newRank), reason: "PROMOTED" };
}
