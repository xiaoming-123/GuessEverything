"use client";

/**
 * 判题后自动翻题：答对 0.7s，答错/超时 1.2s（给阅读解释的时间）。
 * 手动点「下一题」会提前结束，effect 随 phase 切换自动清理。
 */

import { useEffect } from "react";

interface UseAutoNextArgs {
  /** 仅在判题展示阶段计时 */
  active: boolean;
  correct: boolean | null;
  onNext: () => void;
  correctDelay?: number;
  wrongDelay?: number;
}

export function useAutoNext({
  active,
  correct,
  onNext,
  correctDelay = 700,
  wrongDelay = 1200,
}: UseAutoNextArgs): void {
  useEffect(() => {
    if (!active || correct === null) return;
    const timer = setTimeout(onNext, correct ? correctDelay : wrongDelay);
    return () => clearTimeout(timer);
    // onNext 内若读 store 可能每次渲染变化，以阶段/对错为依赖即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, correct]);
}
