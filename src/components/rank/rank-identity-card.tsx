"use client";

/**
 * 身份卡（D1，详设 §1.4）
 *
 * 当前阶 Q 版立绘（D5 前 emoji 占位）+ 大号称号 + 副标题
 * + 功名估算：est = ceil(expToNext / avgExp)，avgExp = 最近 3 局 expGained 均值
 *   （数据源 RankView.recentGames，D1 交付；不足 3 局用全部，无局则不显示估算行）。
 */

import { HERO_AVATARS } from "@/lib/art-assets";
import { ArtAvatar } from "./art-avatar";
import type { RankView } from "@/lib/db/rank-service";

export function RankIdentityCard({ rank }: { rank: RankView }) {
  const avatar = HERO_AVATARS[rank.rankId];
  const isEmperor = rank.ranks[rank.rankId]?.isEmperor ?? false;
  const games = rank.recentGames ?? [];

  // 功名估算：近 3 局均值（无局不显示估算行，详设 §1.4）
  let est: number | null = null;
  if (!isEmperor && rank.expToNext > 0 && games.length > 0) {
    const avgExp = Math.round(games.reduce((s, g) => s + g.expGained, 0) / games.length);
    if (avgExp > 0) est = Math.max(1, Math.ceil(rank.expToNext / avgExp));
  }

  // 最近战绩行（recentGames[0] + seenCount，D1 交付）
  const last = games[0];

  return (
    <div className="rounded-2xl border border-indigo-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <ArtAvatar
          src={avatar}
          containerClassName="h-16 w-16 shrink-0 rounded-2xl border border-indigo-100 bg-indigo-50"
        />
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-bold leading-tight text-indigo-700">{rank.label}</p>
          <p className="mt-0.5 truncate text-xs text-zinc-500">{rank.subtitle}</p>
          <p className="mt-1 text-sm text-indigo-500 tabular-nums">
            功名 {rank.totalExp}
            {!isEmperor && (
              <span className="text-zinc-400">
                {" "}
                · 距下一科考还差 {rank.expToNext}
              </span>
            )}
          </p>
        </div>
      </div>

      {isEmperor && (
        <p className="mt-3 text-sm text-amber-600">👑 位极人臣，已登天子（架空称号终点）</p>
      )}
      {est !== null && (
        <p className="mt-3 text-xs text-zinc-500">
          还差 {rank.expToNext} 功名，约 {est} 局研习
          <span className="ml-1 text-zinc-400">（按近 {games.length} 局均值）</span>
        </p>
      )}
      {last && (
        <p className="mt-1 text-xs text-zinc-500">
          上一局 {last.kind === "EXAM" ? "科考" : last.kind === "DAILY" ? "每日题" : "研习"} ·
          正确率 {last.accuracy}% · +{last.expGained} 功名 · 已见 {rank.seenCount} 题
        </p>
      )}
    </div>
  );
}
