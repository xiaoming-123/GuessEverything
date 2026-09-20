"use client";

/**
 * 官途结算视图（诗词升官 · 阶段 C）
 *
 * 显示功名入账、晋升结果（擢升 / 失败保留功名可重考 / 研习不晋升），
 * 与下一步入口（继续研习 / 重考 / 赴科考）。
 * 数据来自服务端 RankSummary（权威），本组件纯展示。
 */

import type { RankSummary } from "@/lib/db/rank-service";

export function RankSettleView({
  summary,
  onBack,
  onRetry,
}: {
  summary: RankSummary;
  /** 回到官途主页（刷新功名条与路线图） */
  onBack: () => void;
  /** 科考失败时直接重考（不传则只显示回官途） */
  onRetry?: () => void;
}) {
  const { promotion, kind } = summary;
  const isExam = kind === "EXAM";

  const headline = promotion.promoted
    ? `🎉 擢升为「${summary.rank.label}」`
    : isExam
      ? "科考未中"
      : "研习完成";

  const subline = !promotion.promoted
    ? promotion.reason === "EXAM_FAILED"
      ? "功名已保留，补足正确率后可重考"
      : promotion.reason === "EXP_INSUFFICIENT"
        ? "功名未达下一官阶门槛，继续研习积攒"
        : "研习积功名，达门槛后赴科考擢升"
    : "一纸文书，加官进爵";

  return (
    <section className="py-8 text-center">
      <p className="text-zinc-500 mb-3">本局结束</p>

      <div
        className={`mb-4 rounded-2xl border p-6 ${
          promotion.promoted
            ? "border-amber-400 bg-amber-50"
            : isExam && promotion.reason === "EXAM_FAILED"
              ? "border-zinc-200 bg-white"
              : "border-indigo-200 bg-indigo-50"
        }`}
      >
        <p
          className={`text-2xl font-bold ${
            promotion.promoted ? "text-amber-600" : "text-zinc-700"
          }`}
        >
          {headline}
        </p>
        <p className="mt-1 text-sm text-zinc-500">{subline}</p>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-xl border border-zinc-200 bg-white p-3">
          <p className="text-zinc-400">正确率</p>
          <p className="text-lg font-bold tabular-nums">
            {summary.accuracy}%
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-3">
          <p className="text-zinc-400">本局功名</p>
          <p className="text-lg font-bold tabular-nums">+{summary.expGained}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-3">
          <p className="text-zinc-400">累计功名</p>
          <p className="text-lg font-bold tabular-nums">{summary.totalExp}</p>
        </div>
      </div>

      <div className="grid gap-3">
        {onRetry && (
          <button
            onClick={onRetry}
            className="w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
          >
            重考（功名已保留）
          </button>
        )}
        <button
          onClick={onBack}
          className={
            onRetry
              ? "w-full rounded-2xl border border-zinc-300 py-4"
              : "w-full rounded-2xl bg-indigo-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
          }
        >
          {promotion.promoted
            ? `已擢升「${summary.rank.label}」，回到官途`
            : isExam
              ? "回到官途（可重考）"
              : "回到官途（继续研习）"}
        </button>
      </div>
      <p className="mt-4 text-xs text-zinc-400">
        功名只增不减 · 失败保留进度 · 架空称号路线（非真实官制）
      </p>
    </section>
  );
}
