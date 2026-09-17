/**
 * 四玩法统一视觉主题（纯常量，客户端组件共用）
 */
export type QuizTheme = "amber" | "indigo" | "emerald" | "rose";

export const QUIZ_THEME: Record<
  QuizTheme,
  {
    /** 主行动按钮 */
    button: string;
    /** 选项悬停描边 */
    optionHover: string;
    /** 倒计时条/进度条 */
    bar: string;
    /** 主题强调文字 */
    text: string;
    /** 乐观选中态（提交中立即高亮，不等判题） */
    selected: string;
    /** 乐观选中态的标号底色 */
    selectedBadge: string;
  }
> = {
  amber: {
    button: "bg-amber-500",
    optionHover: "hover:border-amber-400",
    bar: "bg-amber-500",
    text: "text-amber-600",
    /** 乐观选中态（提交中立即高亮，不等判题） */
    selected: "border-amber-500 bg-amber-50",
    selectedBadge: "bg-amber-500 text-white",
  },
  indigo: {
    button: "bg-indigo-500",
    optionHover: "hover:border-indigo-400",
    bar: "bg-indigo-500",
    text: "text-indigo-600",
    selected: "border-indigo-500 bg-indigo-50",
    selectedBadge: "bg-indigo-500 text-white",
  },
  emerald: {
    button: "bg-emerald-500",
    optionHover: "hover:border-emerald-400",
    bar: "bg-emerald-500",
    text: "text-emerald-600",
    selected: "border-emerald-500 bg-emerald-50",
    selectedBadge: "bg-emerald-500 text-white",
  },
  rose: {
    button: "bg-rose-500",
    optionHover: "hover:border-rose-400",
    bar: "bg-rose-500",
    text: "text-rose-600",
    selected: "border-rose-500 bg-rose-50",
    selectedBadge: "bg-rose-500 text-white",
  },
};

/** 选项标号 A/B/C/D… */
export const OPTION_LABELS = ["A", "B", "C", "D", "E", "F"];
