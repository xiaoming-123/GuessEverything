"use client";

/**
 * 功名簿页（D2，详设 §2.4）
 *
 * 三区块：
 * - 成就宫格（10 格，已获=彩色+key，未获=剪影+条件描述）——数据源 ACHIEVEMENTS 全表（纯逻辑层，
 *   客户端直接 import）diff 服务端下发的 badges key 集；
 * - 月历（§2.1 cells 渲染，done/made/pending/missing/future 五色，含补签入口）；
 * - 功名总览（totalExp / seenCount / 近 10 局功名小柱状图，数据源 GET /api/games/poetry/rank/ledger）。
 * 架空称号不宣称真实官制。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { LedgerView } from "@/lib/db/rank-service";
import type { DailyView } from "@/lib/games/poetry/weekly";
import { ACHIEVEMENTS } from "@/lib/games/poetry/achievements";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { localPlayerId, usePlayerStore } from "@/store/player-store";

/** 月历格子状态色（done 青绿 / made 琥珀 / pending 靛蓝高亮 / missing 红 / future 灰） */
const CELL_STATE: Record<string, string> = {
  done: "bg-emerald-100 text-emerald-700 border-emerald-200",
  made: "bg-amber-100 text-amber-700 border-amber-200",
  pending: "bg-indigo-500 text-white border-indigo-500",
  missing: "bg-red-50 text-red-400 border-red-100",
  future: "bg-zinc-50 text-zinc-300 border-transparent",
};

/** 状态中文标签（title 提示用） */
const STATE_LABEL: Record<string, string> = {
  done: "已答",
  made: "补签",
  pending: "今日",
  missing: "过期未答",
  future: "未至",
};

export default function LedgerPage() {
  const [view, setView] = useState<LedgerView | null>(null);
  const [error, setError] = useState("");
  const [makeupDate, setMakeupDate] = useState("");
  const [makeupBusy, setMakeupBusy] = useState(false);
  const [makeupMsg, setMakeupMsg] = useState("");

  const load = useCallback(async () => {
    let pid = usePlayerStore.getState().playerId ?? localPlayerId();
    if (!pid) {
      await usePlayerStore.getState().ensurePlayer();
      pid = usePlayerStore.getState().playerId;
    }
    if (!pid) {
      setError("玩家初始化失败，请刷新重试");
      return;
    }
    try {
      const res = await fetch(`/api/games/poetry/rank/ledger?playerId=${encodeURIComponent(pid)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? "功名簿加载失败");
      }
      setView((await res.json()) as LedgerView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "功名簿加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 补签（POST /api/games/poetry/rank/makeup，withCrypto 加密通道）
  const doMakeup = async () => {
    if (!makeupDate || makeupBusy) return;
    const pid = usePlayerStore.getState().playerId ?? localPlayerId();
    if (!pid) return;
    setMakeupBusy(true);
    setMakeupMsg("");
    try {
      await secureFetch<unknown>("/api/games/poetry/rank/makeup", { playerId: pid, date: makeupDate });
      await load();
      setMakeupDate("");
      setMakeupMsg("已补签（纯展示奖励，不加功名）");
    } catch (err) {
      setMakeupMsg(err instanceof Error ? err.message : "补签失败");
    } finally {
      setMakeupBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/play/poetry-rank" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 官途
        </Link>
        <div className="text-sm font-bold text-indigo-600">🏮 功名簿</div>
        <span className="w-10" />
      </div>

      {error ? (
        <div className="py-16 text-center">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      ) : !view ? (
        <div className="py-16 text-center">
          <p className="animate-pulse text-sm text-indigo-600">正在翻阅功名簿…</p>
        </div>
      ) : (
        <div className="space-y-5">
          {/* 功名总览 */}
          <section className="rounded-2xl border border-indigo-100 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">功名总览</p>
            <div className="mt-2 flex items-baseline gap-4">
              <p className="text-3xl font-bold tabular-nums text-indigo-600">{view.totalExp}</p>
              <p className="text-sm text-zinc-500">累计功名</p>
              <p className="ml-auto text-sm text-zinc-500">
                已见 <span className="font-bold tabular-nums text-indigo-600">{view.seenCount}</span> 题
              </p>
            </div>
            {view.recentBars.length > 0 && (
              <div className="mt-4 flex items-end gap-1.5" style={{ height: 48 }}>
                {view.recentBars.map((b, i) => {
                  const max = Math.max(1, ...view.recentBars.map((x) => x.exp));
                  const h = Math.max(4, Math.round((b.exp / max) * 44));
                  return (
                    <div key={i} className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className={`w-full rounded-t ${b.kind === "EXAM" ? "bg-amber-400" : b.kind === "DAILY" ? "bg-emerald-400" : "bg-indigo-400"}`}
                        style={{ height: h }}
                        title={`功名 ${b.exp}（${b.kind}）`}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-1 text-center text-[10px] text-zinc-400">近 {view.recentBars.length} 局功名（靛=研习 / 琥珀=科考 / 青=每日题）</p>
          </section>

          {/* 成就宫格（10 格） */}
          <section>
            <p className="mb-2 text-sm font-semibold text-zinc-700">成就徽章</p>
            <div className="grid grid-cols-5 gap-2">
              {ACHIEVEMENTS.map((a) => {
                const earned = view.badges.includes(a.key);
                return (
                  <div
                    key={a.key}
                    className={`flex flex-col items-center gap-1 rounded-xl border p-2 text-center ${
                      earned ? "border-amber-200 bg-amber-50" : "border-zinc-100 bg-zinc-50"
                    }`}
                  >
                    <span className={earned ? "text-2xl" : "text-2xl opacity-30 grayscale"}>🏅</span>
                    <span className={`text-[10px] leading-tight ${earned ? "font-bold text-amber-700" : "text-zinc-400"}`}>
                      {a.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-zinc-400">
              已获 {view.badges.length}/{ACHIEVEMENTS.length}。
              未获：{ACHIEVEMENTS.filter((a) => !view.badges.includes(a.key)).map((a) => a.label).join("、") || "全部达成"}
            </p>
          </section>

          {/* 月历 */}
          <section className="rounded-2xl border border-indigo-100 bg-white p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-zinc-700">每日题月历</p>
              <span className="text-xs text-zinc-500">
                周连满 {view.daily.weeksCompleted} · 补签余 {view.daily.makeupLeft}
              </span>
            </div>
            <CalendarGrid daily={view.daily} />
            {/* 补签入口（上月过期未答日） */}
            <div className="mt-3 flex items-center gap-2">
              <input
                type="date"
                value={makeupDate}
                onChange={(e) => setMakeupDate(e.target.value)}
                className="rounded-lg border border-zinc-200 px-2 py-1 text-xs"
              />
              <button
                onClick={() => void doMakeup()}
                disabled={!makeupDate || makeupBusy || view.daily.makeupLeft <= 0}
                className={`rounded-lg px-3 py-1 text-xs font-medium ${
                  !makeupDate || makeupBusy || view.daily.makeupLeft <= 0
                    ? "bg-zinc-100 text-zinc-400"
                    : "bg-indigo-500 text-white"
                }`}
              >
                补签
              </button>
              {makeupMsg && <span className="text-xs text-zinc-500">{makeupMsg}</span>}
            </div>
            <p className="mt-1 text-[10px] text-zinc-400">补签仅限上一自然月、每月 1 次；纯展示奖励，不加功名。</p>
          </section>

          <p className="text-center text-xs text-zinc-400">功名只增不减 · 架空称号路线（非真实官制）</p>
        </div>
      )}
    </main>
  );
}

/** 月历网格（周一起排，首尾 null 补空位） */
function CalendarGrid({ daily }: { daily: DailyView }) {
  // 星期表头（周一..周日）
  const weekday = ["一", "二", "三", "四", "五", "六", "日"];
  return (
    <div className="mt-2">
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-zinc-400">
        {weekday.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {daily.cells.map((cell, i) => {
          if (!cell) return <span key={`n${i}`} />;
          const day = Number(cell.date.slice(8));
          return (
            <div
              key={cell.date}
              title={STATE_LABEL[cell.state]}
              className={`flex h-8 flex-col items-center justify-center rounded-md border text-[11px] ${CELL_STATE[cell.state]}`}
            >
              <span className="leading-none">{day}</span>
              {cell.state === "done" && <span className="text-[8px]">✓</span>}
              {cell.state === "made" && <span className="text-[8px]">补</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
