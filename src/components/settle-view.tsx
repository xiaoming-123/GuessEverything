"use client";

/**
 * 结算视图 · 得分 + 星级/正确率/通关提示 + 战绩卡片
 */

import { useState } from "react";
import Link from "next/link";

import { ShareCard, type ShareCardData } from "@/components/share-card";
import type { SettleSummary } from "@/lib/games/stages";

export function SettleView({
  score,
  combo,
  summary,
  cardBase,
  onRestart,
}: {
  score: number;
  combo: number;
  summary: SettleSummary | null;
  /** 分享卡片基础数据（不含本局数据） */
  cardBase: Omit<ShareCardData, "score" | "accuracy" | "combo" | "stars" | "date">;
  onRestart: () => void;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const passed = summary?.passed ?? false;

  return (
    <section className="py-12 text-center">
      <p className="text-zinc-500 mb-2">本局结束</p>
      <p className="text-5xl font-extrabold tabular-nums mb-2">{score}</p>
      {summary && (
        <p className="text-sm text-zinc-500 mb-1">
          正确率 {summary.accuracy}%（{summary.correctCount}/{summary.totalRounds}） · 最高连击 ×{combo}
        </p>
      )}
      {!summary && (
        <p className="text-sm text-zinc-400 mb-1">最高连击 ×{combo}</p>
      )}

      {summary && (
        <div className="my-4">
          <p className="text-2xl tracking-widest">
            {"⭐".repeat(summary.stars)}
            {"☆".repeat(3 - summary.stars)}
          </p>
          {passed ? (
            <p className="mt-2 font-semibold text-emerald-600">
              挑战成功{summary.clearedNow && summary.stars < 3 ? "，下一关已解锁！" : ""}
            </p>
          ) : (
            <p className="mt-2 text-zinc-500">差一点，正确率到 60% 即可通关</p>
          )}
        </div>
      )}

      <div className="mt-8 grid gap-3">
        <button
          onClick={() => setShareOpen(true)}
          className="w-full rounded-2xl border border-amber-400 bg-amber-50 py-4 font-bold text-amber-700"
        >
          📸 生成战绩卡片
        </button>
        <button
          onClick={onRestart}
          className="w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-white"
        >
          再来一局
        </button>
        <Link
          href="/leaderboard"
          className="w-full rounded-2xl border border-zinc-300 py-4"
        >
          看排行榜
        </Link>
        <Link href="/" className="w-full rounded-2xl border border-zinc-300 py-4">
          返回首页
        </Link>
      </div>

      <ShareCard
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        data={{
          ...cardBase,
          score,
          accuracy: summary?.accuracy ?? 0,
          combo,
          stars: summary?.stars ?? 0,
          date: new Date().toLocaleDateString("zh-CN"),
        }}
      />
    </section>
  );
}
