"use client";

/**
 * 对话选择气泡（UI 打磨 2026-09-21 档 A，方案 docs/design/2026-09-21-ui-polish-plan.md）
 *
 * 选项渲染为对话选择气泡（无 A/B/C/D 硬标号）：圆角气泡 + 左侧主题细描边，
 * 选中 / 揭示 / 抖动 / 问同窗灰置的状态逻辑与 ChoiceList 同口径（纯展示层）。
 * ChoiceList 保留为共享组件（其他调用方零影响）。
 */

import { QUIZ_THEME, type QuizTheme } from "./theme";

interface DialogueChoicesProps {
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
  /** 问同窗移除的选项索引（D4：灰置不可点，不泄答案） */
  removedIndexes?: number[];
}

/** 左侧描边色（按主题）：对话气泡的主题细线 */
const BORDER_ACCENT: Record<QuizTheme, string> = {
  amber: "border-l-amber-400",
  indigo: "border-l-indigo-400",
  emerald: "border-l-emerald-400",
  rose: "border-l-rose-400",
};

export function DialogueChoices({
  options,
  selected,
  correctAnswer,
  reveal,
  locked,
  theme,
  onChoose,
  removedIndexes,
}: DialogueChoicesProps) {
  const removed = removedIndexes ? new Set(removedIndexes) : null;
  return (
    <div className="grid gap-3">
      {options.map((opt, i) => {
        const isRemoved = removed?.has(i) ?? false;
        const isSelected = selected === i;
        const isAnswer = correctAnswer !== null && opt === correctAnswer;
        let cls = `border-zinc-200 bg-zinc-50/80 ${QUIZ_THEME[theme].optionHover} ${BORDER_ACCENT[theme]}`;
        if (isRemoved && !reveal) {
          // 问同窗移除项：灰置、不可点（判题态恢复原样式以便揭示正确答案）
          cls = "border-zinc-100 bg-zinc-50 opacity-40";
        } else if (reveal && isAnswer) {
          cls = "border-emerald-500 border-l-emerald-500 bg-emerald-50 font-semibold animate-correct-pop";
        } else if (reveal && isSelected && !isAnswer) {
          cls = "border-red-400 border-l-red-400 bg-red-50 animate-shake";
        } else if (reveal) {
          cls = "border-zinc-200 bg-zinc-50 opacity-60";
        } else if (isSelected) {
          // 乐观选中态：点击立即高亮，不等服务端判题往返
          cls = `${QUIZ_THEME[theme].selected} border-l-[3px] font-semibold`;
        }
        return (
          <button
            key={i}
            type="button"
            disabled={reveal || locked || isRemoved}
            onClick={() => onChoose(i)}
            style={{ animationDelay: `${i * 45}ms` }}
            className={`animate-question-in w-full rounded-2xl border border-l-2 px-4 py-3 text-left text-sm leading-relaxed transition active:scale-[0.99] disabled:cursor-default ${cls}`}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
