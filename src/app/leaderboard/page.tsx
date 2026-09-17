"use client";

/**
 * 排行榜页 · 按模式 + 关卡查看历史最高分榜（top 50）
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { STAGE_ORDER, STAGE_LABEL, type GameMode } from "@/lib/games/stages";
import { usePlayerStore } from "@/store/player-store";

const MODES: { key: GameMode; label: string; icon: string }[] = [
  { key: "POETRY", label: "诗词猜猜", icon: "📜" },
  { key: "ACTOR", label: "演员猜猜", icon: "🎬" },
  { key: "OBJECT", label: "物品猜猜", icon: "🧩" },
  { key: "FEIHUA", label: "飞花令", icon: "🌸" },
];

interface LeaderboardRow {
  rank: number;
  playerId: string;
  nickname: string;
  avatar: string;
  bestScore: number;
}

interface LeaderboardData {
  mode: GameMode;
  stage: string;
  top: LeaderboardRow[];
  me: LeaderboardRow | null;
}

const MEDALS = ["🥇", "🥈", "🥉"];

export default function LeaderboardPage() {
  const [mode, setMode] = useState<GameMode>("POETRY");
  const [stage, setStage] = useState(STAGE_ORDER.POETRY[0]);
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const playerId = usePlayerStore((s) => s.playerId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ mode, stage });
      if (playerId) params.set("playerId", playerId);
      const res = await fetch(`/api/leaderboard?${params.toString()}`, { cache: "no-store" });
      if (res.ok) setData((await res.json()) as LeaderboardData);
    } finally {
      setLoading(false);
    }
  }, [mode, stage, playerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchMode = (m: GameMode) => {
    setMode(m);
    setStage(STAGE_ORDER[m][0]);
  };

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 返回
        </Link>
        <div className="text-sm font-medium">🏆 排行榜</div>
        <div className="w-10" />
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => switchMode(m.key)}
            className={`rounded-xl border px-2 py-2 text-sm transition ${
              mode === m.key
                ? "border-amber-500 bg-amber-50 font-semibold"
                : "border-zinc-200 bg-white"
            }`}
          >
            {m.icon} {m.label}
          </button>
        ))}
      </div>

      <div className="mb-6 flex gap-2">
        {STAGE_ORDER[mode].map((s, i) => (
          <button
            key={s}
            onClick={() => setStage(s)}
            className={`rounded-full border px-4 py-1.5 text-xs transition ${
              stage === s
                ? "border-amber-500 bg-amber-500 text-white"
                : "border-zinc-200 bg-white text-zinc-600"
            }`}
          >
            第{i + 1}关 {STAGE_LABEL[s]}
          </button>
        ))}
      </div>

      {loading && <p className="py-16 text-center text-zinc-400">加载中…</p>}

      {!loading && data && data.top.length === 0 && (
        <p className="py-16 text-center text-zinc-400">暂无上榜战绩，快来抢占第一！</p>
      )}

      {!loading && data && data.top.length > 0 && (
        <ul className="grid gap-2">
          {data.top.map((row) => {
            const isMe = playerId === row.playerId;
            return (
              <li
                key={row.playerId}
                className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
                  isMe ? "border-amber-500 bg-amber-50" : "border-zinc-200 bg-white"
                }`}
              >
                <span className="w-8 text-center text-lg font-bold">
                  {MEDALS[row.rank - 1] ?? row.rank}
                </span>
                <span className="text-2xl">{row.avatar}</span>
                <span className="flex-1 truncate font-medium">{row.nickname}</span>
                <span className="tabular-nums font-bold">{row.bestScore}</span>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && data?.me && data.me.rank > 50 && (
        <p className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          我的排名：第 {data.me.rank} 名 · {data.me.bestScore} 分
        </p>
      )}
    </main>
  );
}
