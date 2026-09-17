"use client";

/**
 * 单题判题反馈卡：对错/超时文案 + 解释 + 手动翻题按钮
 * 自动翻题由 useAutoNext 负责，本卡只做展示。
 */

import { QUIZ_THEME, type QuizTheme } from "./theme";

interface JudgeCardProps {
  correct: boolean;
  timeout?: boolean;
  correctAnswer: string;
  explanation: string;
  gained: number;
  multiplier: number;
  isLast: boolean;
  theme: QuizTheme;
  onNext: () => void;
}

export function JudgeCard({
  correct,
  timeout = false,
  correctAnswer,
  explanation,
  gained,
  multiplier,
  isLast,
  theme,
  onNext,
}: JudgeCardProps) {
  const headline = correct
    ? `答对 +${gained}（×${multiplier.toFixed(1)}）`
    : timeout
      ? `⏰ 超时了，正确答案：${correctAnswer}`
      : `答错了，正确答案：${correctAnswer}`;

  return (
    <div className="animate-reveal-in mt-6 rounded-2xl border border-zinc-200 bg-white p-4">
      <p
        className={`mb-1 font-bold ${
          correct ? "text-emerald-600" : "text-red-500"
        }`}
      >
        {headline}
      </p>
      <p className="mb-4 text-sm leading-relaxed text-zinc-500">{explanation}</p>
      <button
        type="button"
        onClick={onNext}
        className={`w-full rounded-xl py-3 font-bold text-white ${QUIZ_THEME[theme].button} active:scale-[0.99]`}
      >
        {isLast ? "查看结算" : "下一题"}
      </button>
    </div>
  );
}
