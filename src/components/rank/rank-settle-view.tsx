"use client";

/**
 * 官途结算视图（D1 扩展，详设 §1.5：结算仪式感）
 *
 * - 擢升（PROMOTED）：上下两段对比——旧官衔（小、置灰）→ 新官衔（大、琥珀金、
 *   Q 版立绘放大 1.2× + 入场 300ms 缩放动画）；settleLine 居中台词；
 *   功名入账滚动数字（requestAnimationFrame 800ms，纯展示）。
 * - 失败（EXAM_FAILED）：failLine（含正确率与缺口题数）+「直接重考」主按钮。
 * - 研习（KIND_NOT_EXAM）：practiceLine + 功名条从旧值到新值的宽度动画（CSS transition）。
 * - 皇帝终点：布衣 → 皇帝两张立绘并排 + 固定文案。
 *
 * 数据来自服务端 RankSummary（权威），本组件纯展示。
 */

import { useEffect, useState } from "react";
import { HERO_AVATARS } from "@/lib/art-assets";
import { RANKS } from "@/lib/games/poetry/rank";
import { ACHIEVEMENT_BY_KEY } from "@/lib/games/poetry/achievements";
import { ArtAvatar } from "./art-avatar";
import type { RankSummary } from "@/lib/db/rank-service";

/** 滚动数字（requestAnimationFrame 800ms，纯展示） */
function RollNumber({ from, to }: { from: number; to: number }) {
  const [value, setValue] = useState(from);
  useEffect(() => {
    if (from === to) {
      setValue(to);
      return;
    }
    const start = performance.now();
    const DURATION = 800;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [from, to]);
  return <span className="tabular-nums">{value}</span>;
}

/** 功名条宽度动画（CSS transition，旧值 → 新值） */
function ExpBar({ from, to, required }: { from: number; to: number; required: number }) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const startPct = required > 0 ? Math.min(100, (from / required) * 100) : 0;
    const endPct = required > 0 ? Math.min(100, (to / required) * 100) : 100;
    // 先置 0 再过渡：首帧强制 reflow 后切到 endPct（CSS transition 生效）
    setWidth(startPct);
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setWidth(endPct)),
    );
    return () => cancelAnimationFrame(raf);
  }, [from, to, required]);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-indigo-100">
      <div
        className="h-full rounded-full bg-indigo-500 transition-[width] duration-700 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

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
  const isDaily = kind === "DAILY";
  const promoted = promotion.promoted;
  const isExamFailed = !promoted && isExam && promotion.reason === "EXAM_FAILED";
  const fromLabel = RANKS[summary.rankId]?.label ?? "";
  const toLabel = promoted
    ? RANKS[promotion.newRank]?.label ?? summary.rank.label
    : summary.rank.label;
  const isEmperorEnd = promoted && promotion.newRank === RANKS.length - 1 && RANKS[promotion.newRank]?.isEmperor;
  // 本次新达成成就（D2：服务端只下发 key，文案客户端查纯逻辑表）
  const newBadges = (summary.newBadges ?? []).map(
    (k) => ACHIEVEMENT_BY_KEY.get(k),
  ).filter((a): a is NonNullable<typeof a> => !!a);

  const headline = promoted
    ? `🎉 擢升为「${toLabel}」`
    : isExam
      ? "科考未中"
      : isDaily
        ? "每日题完成"
        : "研习完成";

  const subline = !promoted
    ? isExamFailed
      ? "功名已保留，补足正确率后可重考"
      : promotion.reason === "EXP_INSUFFICIENT"
        ? "功名未达下一官阶门槛，继续研习积攒"
        : "研习积功名，达门槛后赴科考擢升"
    : "一纸文书，加官进爵";

  return (
    <section className="py-8 text-center">
      <p className="text-zinc-500 mb-3">本局结束</p>

      {/* 擢升：上下两段对比（旧官衔小置灰 → 新官衔大琥珀金 + 立绘放大入场） */}
      {promoted && (
        <div className="animate-settle-card mb-4 rounded-2xl border border-amber-400 bg-amber-50 p-6">
          {isEmperorEnd ? (
            // 皇帝终点：布衣 → 皇帝两张立绘并排
            <div className="flex items-center justify-center gap-6">
              <div className="animate-settle-promote opacity-60 grayscale">
                <ArtAvatar src={HERO_AVATARS[0]} containerClassName="h-24 w-24" />
              </div>
              <span className="text-2xl text-amber-500">→</span>
              <div className="animate-settle-promote" style={{ animationDelay: "120ms" }}>
                <ArtAvatar src={HERO_AVATARS[promotion.newRank]} containerClassName="h-28 w-28" />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <p className="text-sm text-zinc-400 line-through decoration-zinc-300">
                {fromLabel}
              </p>
              <div
                className="animate-settle-promote mt-2"
                style={{ transform: "scale(1.2)" }}
              >
                <ArtAvatar src={HERO_AVATARS[promotion.newRank]} containerClassName="h-28 w-28" />
              </div>
              <p className="mt-2 bg-gradient-to-r from-amber-500 to-amber-600 bg-clip-text text-3xl font-bold text-transparent">
                {toLabel}
              </p>
            </div>
          )}
          {/* 结算台词（服务端 persona 拼装） */}
          <p className="mt-4 text-sm font-medium text-amber-700">{summary.settleLine}</p>
          {isEmperorEnd && (
            <p className="mt-1 text-xs text-amber-600">
              位极人臣，已登天子（架空称号终点）
            </p>
          )}
        </div>
      )}

      {/* 失败 / 研习：卡片（失败=中性底；研习=indigo 底） */}
      {!promoted && (
        <div
          className={`animate-settle-card mb-4 rounded-2xl border p-6 ${
            isExamFailed ? "border-zinc-200 bg-white" : "border-indigo-200 bg-indigo-50"
          }`}
        >
          <p
            className={`text-2xl font-bold ${isExamFailed ? "text-zinc-700" : "text-indigo-700"}`}
          >
            {headline}
          </p>
          {/* 结算台词：失败句（含正确率与缺口题数）/ 研习句 */}
          <p className="mt-2 text-sm text-zinc-600">{summary.settleLine}</p>
          <p className="mt-1 text-xs text-zinc-400">{subline}</p>
          {/* 研习：功名条旧值 → 新值宽度动画 */}
          {!isExam && !isExamFailed && (
            <div className="mt-4">
              <ExpBar
                from={summary.totalExp - summary.expGained}
                to={summary.totalExp}
                required={summary.rank.expToNext > 0 ? summary.rank.totalExp + summary.rank.expToNext : 1}
              />
              <p className="mt-1 text-xs text-indigo-400">
                功名 {summary.totalExp - summary.expGained} → <RollNumber from={summary.totalExp - summary.expGained} to={summary.totalExp} />
              </p>
            </div>
          )}
        </div>
      )}

      <div className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-xl border border-zinc-200 bg-white p-3">
          <p className="text-zinc-400">正确率</p>
          <p className="text-lg font-bold tabular-nums">
            {summary.accuracy}%
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-3">
          <p className="text-zinc-400">本局功名</p>
          <p className="text-lg font-bold tabular-nums">
            +<RollNumber from={0} to={summary.expGained} />
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-3">
          <p className="text-zinc-400">累计功名</p>
          <p className="text-lg font-bold">
            <RollNumber from={summary.totalExp - summary.expGained} to={summary.totalExp} />
          </p>
        </div>
      </div>

      {/* 本次新达成成就（D2） */}
      {newBadges.length > 0 && (
        <div className="animate-settle-card mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-bold text-amber-700">🏅 新达成成就</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {newBadges.map((a) => (
              <span
                key={a.key}
                className="rounded-full border border-amber-200 bg-white px-3 py-1 text-xs font-medium text-amber-700"
              >
                {a.label}
                <span className="ml-1 text-amber-400">{a.desc}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3">
        {onRetry && (
          <button
            onClick={onRetry}
            className="w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
          >
            直接重考（功名已保留）
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
          {promoted
            ? `已擢升「${toLabel}」，回到官途`
            : isExam
              ? "回官途（可重考）"
              : "回到官途（继续研习）"}
        </button>
      </div>
      <p className="mt-4 text-xs text-zinc-400">
        功名只增不减 · 失败保留进度 · 架空称号路线（非真实官制）
      </p>
    </section>
  );
}
