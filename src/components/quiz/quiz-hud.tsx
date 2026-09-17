"use client";

/**
 * 对局顶部 HUD：总进度条 + 每题倒计时条 + 连击徽章
 *
 * 倒计时仅为前端体验/自动提交依据，权威判错在服务端。
 */

import { useEffect, useRef, useState } from "react";
import { QUIZ_THEME, type QuizTheme } from "./theme";

interface QuizHUDProps {
  index: number;
  total: number;
  combo: number;
  /** 本题开始时刻（ms 时间戳），换题时重置 */
  roundStartedAt: number;
  /** 本题时限 ms */
  durationMs: number;
  /** PLAYING 走表；REVEAL 冻结 */
  active: boolean;
  theme: QuizTheme;
  /** 时间到（只触发一次，由页面发起超时提交） */
  onTimeout: () => void;
}

const TICK_MS = 100;

export function QuizHUD({
  index,
  total,
  combo,
  roundStartedAt,
  durationMs,
  active,
  theme,
  onTimeout,
}: QuizHUDProps) {
  const [remaining, setRemaining] = useState(durationMs);
  const firedRef = useRef(false);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  // 换题/重开：重置倒计时
  useEffect(() => {
    firedRef.current = false;
    setRemaining(durationMs);
  }, [durationMs, roundStartedAt, index]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const left = durationMs - (Date.now() - roundStartedAt);
      if (left <= 0) {
        setRemaining(0);
        clearInterval(timer);
        if (!firedRef.current) {
          firedRef.current = true;
          onTimeoutRef.current();
        }
      } else {
        setRemaining(left);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [active, durationMs, roundStartedAt, index]);

  const pct = Math.max(0, Math.min(1, remaining / durationMs));
  const totalPct = Math.min(1, index / total);
  const urgent = active && remaining <= 5_000;
  const seconds = Math.ceil(remaining / 1000);

  return (
    <div className="mb-3">
      {/* 总进度 */}
      <div className="mb-2 flex items-center justify-between text-xs text-zinc-400">
        <span>
          第 {index + 1} / {total} 题
        </span>
        {combo > 1 && (
          <span
            key={combo}
            className="animate-combo-pop rounded-full bg-orange-50 px-2 py-0.5 font-semibold text-orange-500"
          >
            🔥 连击 ×{combo}
          </span>
        )}
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded-full bg-zinc-100">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${QUIZ_THEME[theme].bar}`}
          style={{ width: `${totalPct * 100}%` }}
        />
      </div>

      {/* 每题倒计时 */}
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
          <div
            className={`h-full rounded-full ${
              urgent ? "bg-red-500" : QUIZ_THEME[theme].bar
            }`}
            style={{ width: `${pct * 100}%`, transition: `width ${TICK_MS}ms linear` }}
          />
        </div>
        <span
          className={`w-8 text-right text-xs font-bold tabular-nums ${
            urgent ? "animate-timer-urgent text-red-500" : "text-zinc-400"
          }`}
        >
          {active ? `${seconds}s` : ""}
        </span>
      </div>
    </div>
  );
}
