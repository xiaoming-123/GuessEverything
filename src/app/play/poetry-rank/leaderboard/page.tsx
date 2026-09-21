"use client";

/**
 * 皇榜（排行榜）页（D6，详设 §4.5）
 *
 * 金殿主题（琥珀金，与 indigo 主调形成反差）：
 * - 列表 Top 100（虚拟 + 真实合并）；前三名 🥇🥈🥉 印章标记；
 *   虚拟位带名人小传（点击展开）。
 * - 底部我的追赶卡片（低压力叙事，不展示全量精确名次）。
 * - 数据源 GET /api/games/poetry/rank/leaderboard（明文视图）。
 * 架空称号不宣称真实官制。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LeaderboardView } from "@/lib/db/leaderboard-service";
import type { LeaderboardEntry } from "@/lib/games/poetry/leaderboard";
import { localPlayerId, usePlayerStore } from "@/store/player-store";

/** 虚拟名人小传（公版名人，架空官衔，不宣称真实官制） */
const VIRTUAL_BIO: Record<string, string> = {
  李白: "诗仙，斗酒诗百篇。",
  苏轼: "东坡居士，一蓑烟雨任平生。",
  辛弃疾: "稼轩，醉里挑灯看剑。",
  王勃: "初唐四杰，《滕王阁序》。",
  孟浩然: "布衣之交，微云淡河汉。",
};

const MEDALS = ["🥇", "🥈", "🥉"];

export default function LeaderboardPage() {
  const [view, setView] = useState<LeaderboardView | null>(null);
  const [error, setError] = useState("");
  const [openBio, setOpenBio] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let pid = usePlayerStore.getState().playerId ?? localPlayerId();
      if (!pid) {
        await usePlayerStore.getState().ensurePlayer();
        pid = usePlayerStore.getState().playerId;
      }
      try {
        const res = await fetch(
          `/api/games/poetry/rank/leaderboard${pid ? `?playerId=${encodeURIComponent(pid)}` : ""}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? "皇榜加载失败");
        }
        const v = (await res.json()) as LeaderboardView;
        if (!cancelled) setView(v);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "皇榜加载失败");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/play/poetry-rank" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 官途
        </Link>
        <div className="text-sm font-bold text-amber-600">📜 皇榜</div>
        <span className="w-10" />
      </div>

      {error ? (
        <div className="py-16 text-center">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      ) : !view ? (
        <div className="py-16 text-center">
          <p className="animate-pulse text-sm text-amber-600">正在展开金榜…</p>
        </div>
      ) : (
        <>
          {/* 赛季标签（P3-2：季度榜头部） */}
          <p className="mb-3 text-center text-sm font-bold text-amber-700">
            {view.seasonLabel}榜
          </p>

          {/* 金榜（Top 100） */}
          <ol className="overflow-hidden rounded-2xl border border-amber-300 bg-amber-50/60">
            {view.items.map((e, i) => (
              <BoardRow
                key={`${e.name}-${e.totalExp}-${i}`}
                entry={e}
                index={i}
                open={openBio === `${e.name}-${i}`}
                onToggle={() =>
                  e.isVirtual ? setOpenBio(openBio === `${e.name}-${i}` ? null : `${e.name}-${i}`) : undefined
                }
              />
            ))}
          </ol>

          {/* 我的追赶卡片（低压力叙事） */}
          {view.my ? (
            <div className="mt-4 rounded-2xl border border-amber-300 bg-white p-4">
              <p className="text-sm font-bold text-amber-700">
                {view.my.rankLabel} · 本季功名 {view.my.seasonExp}
                <span className="ml-2 text-xs font-normal text-zinc-400">
                  名列第 {view.my.aboveCount + 1} 位
                </span>
              </p>
              <p className="mt-1 text-sm text-zinc-600">
                {view.my.aboveCount === 0
                  ? "你高居金榜首位，无人可及。"
                  : `与第 ${view.my.aboveCount} 位「${view.my.aboveName}」（${view.my.aboveLabel}）只有一卷之差（本季还差 ${Math.max(
                      0,
                      view.my.aboveExp - view.my.seasonExp,
                    )} 功名）。`}
              </p>
            </div>
          ) : (
            <div className="mt-4 rounded-2xl border border-amber-300 bg-white p-4">
              <p className="text-sm font-bold text-amber-700">我的位次</p>
              <p className="mt-1 text-sm text-zinc-600">
                距金榜（前 {view.items.length} 位）还有一卷之遥——研习积功名，上榜即是。
              </p>
            </div>
          )}

          {/* 我的往期战绩（P3-2 详设 §2.5：SeasonBoard 快照，无快照不渲染） */}
          {view.past.length > 0 && (
            <div className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-sm font-bold text-zinc-700">📜 往期定格</p>
              <ul className="mt-2 space-y-1">
                {view.past.map((s) => (
                  <li key={s.seasonKey} className="flex items-center justify-between text-xs text-zinc-500">
                    <span>{s.label}</span>
                    <span>
                      {s.rankLabel} · 季功名 {s.seasonExp}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-4 text-center text-xs text-zinc-400">
            金榜按本季功名 · 官阶排序 · 架空称号路线（非真实官制）· 官阶与累计功名常青不清零
          </p>
        </>
      )}
    </main>
  );
}

/** 榜单行（前三名印章 / 虚拟位小传展开） */
function BoardRow({
  entry,
  index,
  open,
  onToggle,
}: {
  entry: LeaderboardEntry;
  index: number;
  open: boolean;
  onToggle?: () => void;
}) {
  const top3 = index < 3;
  return (
    <li
      className={`flex items-start gap-3 border-b border-amber-100 px-4 py-3 last:border-b-0 ${
        top3 ? "bg-amber-50" : "bg-white/70"
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center text-sm font-bold ${
          top3 ? "text-lg" : "rounded-full bg-zinc-100 text-zinc-500"
        }`}
      >
        {top3 ? MEDALS[index] : index + 1}
      </span>
      <span className="text-xl">{entry.avatar}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-zinc-800">
          {entry.name}
          {entry.isVirtual && (
            <button
              type="button"
              onClick={onToggle}
              className="ml-1 text-xs text-amber-500 underline decoration-dotted"
            >
              小传
            </button>
          )}
        </p>
        <p className="text-xs text-zinc-500">
          {entry.rankLabel} · 本季功名 {entry.seasonExp}
          {open && VIRTUAL_BIO[entry.name] && (
            <span className="mt-1 block text-amber-700">{VIRTUAL_BIO[entry.name]}</span>
          )}
        </p>
      </div>
      {entry.isVirtual && (
        <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[10px] text-amber-600">
          名人
        </span>
      )}
    </li>
  );
}
