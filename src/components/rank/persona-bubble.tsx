"use client";

/**
 * 人设对话气泡（D1，详设 §1.3）
 *
 * 输入 { avatar, expression?, text, variant }：
 * - variant=question：题面气泡（头像 + 署名 + 题面文本），倒计时只在此气泡激活；
 * - variant=feedback：判题反馈气泡（文本 = 服务端 lastJudge.feedback，出处行保留）。
 *
 * 头像走 art-assets 常量表（D5 前 emoji 占位）；表情在 D5 前不渲染（复用立绘本体）。
 */

import { NPC_AVATARS, npcExpressionAsset } from "@/lib/art-assets";
import { PERSONA_LABEL, type PersonaKey } from "@/lib/games/poetry/persona";
import { ArtAvatar } from "./art-avatar";

interface PersonaBubbleProps {
  persona: PersonaKey;
  expression?: "normal" | "happy" | "surprised" | "sad";
  text: string;
  variant: "question" | "feedback";
  /** 题面文本（variant=question 时展示在气泡正文区） */
  prompt?: string;
  /** 题面引导语（如「这句诗的作者是？」） */
  typeLabel?: string;
  /** 连击数（>=3 时气泡边框升级：3 琥珀描边 / 5 琥珀光晕，纯 CSS） */
  combo?: number;
  /** 反馈变体：正确答案（判后揭晓） */
  correctAnswer?: string;
  /** 反馈变体：本题判分（对 +N / 错 0） */
  gained?: number;
  /** 反馈变体：是否最后一题（按钮文案：查看结算 / 下一题） */
  isLast?: boolean;
  /** 反馈变体：手动翻题（自动翻题由 useAutoNext 负责，按钮仅兜底） */
  onNext?: () => void;
}

export function PersonaBubble({
  persona,
  expression,
  text,
  variant,
  prompt,
  typeLabel,
  combo = 0,
  correctAnswer,
  gained,
  isLast,
  onNext,
}: PersonaBubbleProps) {
  // 头像：有表情且人设有表情图时优先用表情（D5），否则回退立绘本体
  const baseAvatar = NPC_AVATARS[persona];
  const exprAvatar =
    expression && expression !== "normal"
      ? npcExpressionAsset(persona, expression)
      : null;
  const avatar = exprAvatar ?? baseAvatar;

  // 连击视觉三档：0-2 普通 indigo 描边；3-4 琥珀金描边；>=5 琥珀金光晕（纯 CSS）
  const frameCls =
    variant === "feedback"
      ? text.startsWith("对。")
        ? "border-emerald-300 bg-emerald-50/60"
        : "border-red-200 bg-red-50/40"
      : combo >= 5
        ? "border-amber-400 bg-amber-50/50 shadow-[0_0_18px_rgba(251,191,36,0.45)]"
        : combo >= 3
          ? "border-amber-300 bg-amber-50/40"
          : "border-zinc-200 bg-white";

  return (
    <div className={`rounded-2xl border p-4 transition-all duration-300 ${frameCls}`}>
      <div className="flex items-start gap-3">
        {/* 头像（D5：<img> 立绘/表情，未入库回退 emoji） */}
        <ArtAvatar
          src={avatar}
          containerClassName="h-11 w-11 shrink-0 rounded-full border border-zinc-200 bg-white"
        />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-medium text-zinc-400">
            {PERSONA_LABEL[persona]}
            {variant === "question" && typeLabel ? ` · ${typeLabel}` : ""}
          </p>
          {/* 对话文本 */}
          <p className="text-sm leading-relaxed text-zinc-700">{text}</p>
          {/* 题面（仅 question 变体） */}
          {variant === "question" && prompt && (
            <div className="mt-3 rounded-xl border border-zinc-100 bg-zinc-50/70 p-4 text-center">
              <p className="text-xl font-semibold leading-relaxed text-zinc-900">
                {prompt}
              </p>
            </div>
          )}
          {/* 反馈变体：判后信息（正确答案 + 判分 + 翻题按钮）。
              出处行已含在 feedback 文本内（persona.feedbackLine 拼了 explanation），不重复渲染。 */}
          {variant === "feedback" && (
            <div className="mt-3 space-y-2">
              <p
                className={`text-sm font-semibold ${
                  text.startsWith("对。") ? "text-emerald-600" : "text-red-500"
                }`}
              >
                {text.startsWith("对。") ? (
                  <span>
                    答对 +{gained ?? 0}
                    {typeof correctAnswer === "string" && `（答案：${correctAnswer}）`}
                  </span>
                ) : (
                  <span>
                    {text.startsWith("时辰到了。") ? "⏰ 超时" : "答错"}
                    {typeof correctAnswer === "string" && `，正确答案：${correctAnswer}`}
                  </span>
                )}
              </p>
              {onNext && (
                <button
                  type="button"
                  onClick={onNext}
                  className="w-full rounded-xl bg-indigo-500 py-3 font-bold text-white active:scale-[0.99]"
                >
                  {isLast ? "查看结算" : "下一题"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
