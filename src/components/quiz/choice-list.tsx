"use client";

/**
 * 四选一选项列表：A/B/C/D 标号 + 作答/判题态样式 + 微动效
 */

import { OPTION_LABELS, QUIZ_THEME, type QuizTheme } from "./theme";

interface ChoiceListProps {
  options: string[];
  /** 已选项（超时未选时为 null） */
  selected: number | null;
  /** 判题阶段的正确答案 */
  correctAnswer: string | null;
  reveal: boolean;
  /** 提交中（防超时与点击双发） */
  locked: boolean;
  theme: QuizTheme;
  onChoose: (index: number) => void;
  /** 问同窗移除的选项索引（D4 详设 §4.1：灰置不可点，不泄答案） */
  removedIndexes?: number[];
}

export function ChoiceList({
  options,
  selected,
  correctAnswer,
  reveal,
  locked,
  theme,
  onChoose,
  removedIndexes,
}: ChoiceListProps) {
  const removed = removedIndexes ? new Set(removedIndexes) : null;
  return (
    <div className="grid gap-3">
      {options.map((opt, i) => {
        const isRemoved = removed?.has(i) ?? false;
        const isSelected = selected === i;
        const isAnswer = correctAnswer !== null && opt === correctAnswer;
        let cls = `border-zinc-200 bg-white ${QUIZ_THEME[theme].optionHover}`;
        let badgeCls = "bg-zinc-100 text-zinc-500";
        if (isRemoved && !reveal) {
          // 问同窗移除项：灰置、不可点（判题态恢复原样式以便揭示正确答案）
          cls = "border-zinc-100 bg-zinc-50 opacity-40";
          badgeCls = "bg-zinc-100 text-zinc-300";
        } else if (reveal && isAnswer) {
          cls = "border-emerald-500 bg-emerald-50 font-semibold animate-correct-pop";
          badgeCls = "bg-emerald-500 text-white";
        } else if (reveal && isSelected && !isAnswer) {
          cls = "border-red-400 bg-red-50 animate-shake";
          badgeCls = "bg-red-400 text-white";
        } else if (reveal) {
          cls = "border-zinc-200 bg-white opacity-60";
        } else if (isSelected) {
          // 乐观选中态：点击立即高亮，不等服务端判题往返
          cls = `${QUIZ_THEME[theme].selected} font-semibold`;
          badgeCls = QUIZ_THEME[theme].selectedBadge;
        }
        return (
          <button
            key={i}
            type="button"
            disabled={reveal || locked || isRemoved}
            onClick={() => onChoose(i)}
            style={{ animationDelay: `${i * 45}ms` }}
            className={`animate-question-in flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition active:scale-[0.98] disabled:cursor-default ${cls}`}
          >
            <span
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${badgeCls}`}
            >
              {OPTION_LABELS[i] ?? i + 1}
            </span>
            <span className="flex-1">{opt}</span>
          </button>
        );
      })}
    </div>
  );
}
