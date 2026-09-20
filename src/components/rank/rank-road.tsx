"use client";

/**
 * 官途路线图 + 功名条（诗词升官 · 阶段 C 前端）
 *
 * 架空称号路线（布衣 → 11 阶官衔 + 皇帝），文案不宣称为真实官制；
 * 数据来自服务端 RankView（功名权威值），本组件纯展示。
 */

import type { RankView } from "@/lib/db/rank-service";

export function RankRoad({ rank }: { rank: RankView }) {
  // 功名进度 = 已得 / 所需；所需功名 = totalExp + expToNext（未解锁时）
  const required = rank.totalExp + rank.expToNext;
  const pct = rank.nextUnlocked
    ? 1
    : required > 0
      ? Math.max(0, Math.min(1, rank.totalExp / required))
      : 0;
  const isEmperor = rank.ranks[rank.rankId]?.isEmperor ?? false;

  return (
    <div>
      {/* 功名条 */}
      <div className="mb-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-lg font-bold text-indigo-700">
            {rank.label}
            <span className="ml-2 text-xs font-normal text-indigo-400">
              {rank.subtitle}
            </span>
          </span>
          <span className="text-sm text-indigo-500 tabular-nums">
            功名 {rank.totalExp}
          </span>
        </div>
        {isEmperor ? (
          <p className="mt-2 text-sm text-amber-600">
            👑 位极人臣，已登天子（架空称号终点）
          </p>
        ) : rank.nextUnlocked ? (
          <p className="mt-2 text-sm font-medium text-emerald-600">
            ✓ 功名达标，可赴下一场科考
          </p>
        ) : (
          <>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-indigo-100">
              <div
                className="h-full rounded-full bg-indigo-500 transition-[width]"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-indigo-400 tabular-nums">
              距下一场科考还差 {rank.expToNext} 功名
            </p>
          </>
        )}
      </div>

      {/* 官途路线（垂直） */}
      <ol className="relative space-y-1 pl-4">
        <span className="absolute top-2 bottom-2 left-[7px] w-px bg-zinc-200" />
        {rank.ranks.map((r) => {
          const passed = r.rankId < rank.rankId;
          const current = r.rankId === rank.rankId;
          return (
            <li key={r.key} className="relative flex items-center gap-3 py-1">
              <span
                className={`absolute -left-4 h-3.5 w-3.5 rounded-full border-2 ${
                  current
                    ? "border-indigo-500 bg-indigo-500"
                    : passed
                      ? "border-indigo-400 bg-indigo-300"
                      : "border-zinc-300 bg-white"
                }`}
              />
              <span
                className={`flex-1 text-sm ${
                  current
                    ? "font-bold text-indigo-700"
                    : passed
                      ? "text-zinc-500"
                      : "text-zinc-400"
                }`}
              >
                {r.label}
                <span className="ml-2 text-xs text-zinc-400">{r.subtitle}</span>
              </span>
              {r.isEmperor && (
                <span className="text-xs text-amber-500">👑 登极大考</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
