"use client";

/**
 * 诗词阁页（D3，详设 §3.1）
 *
 * 玩家答过的诗（按 poemId 去重，答过即入库不论对错）。
 * 顶部：total / 语料总数（语料总数走 GET /api/games/poetry/rank 的 RankView.corpusTotal）。
 * 主体：朝代 / 学段 两个分组过滤条（点击过滤）+ 诗卡列表
 * （卡 = 标题 / 作者 / 朝代 / 「已通」章 + 展开看全文；lines 全文公版语料）。
 * 架空称号不宣称真实官制。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { GalleryView } from "@/lib/db/rank-service";
import { localPlayerId, usePlayerStore } from "@/store/player-store";

const PAGE_SIZE = 20;

export default function GalleryPage() {
  const [view, setView] = useState<GalleryView | null>(null);
  const [corpusTotal, setCorpusTotal] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [dynFilter, setDynFilter] = useState<string | null>(null);
  const [gradeFilter, setGradeFilter] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (p: number, dyn: string | null, grade: number | null) => {
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
      // gallery 视图 + 语料总数（RankView.corpusTotal，详设 §3.1）并行
      const qs = new URLSearchParams({ playerId: pid, page: String(p), pageSize: String(PAGE_SIZE) });
      if (dyn) qs.set("dynasty", dyn);
      if (grade !== null) qs.set("grade", String(grade));
      const [gRes, rankRes] = await Promise.all([
        fetch(`/api/games/poetry/rank/gallery?${qs.toString()}`),
        fetch(`/api/games/poetry/rank?playerId=${encodeURIComponent(pid)}`),
      ]);
      if (!gRes.ok) {
        const body = await gRes.json().catch(() => null);
        throw new Error(body?.error?.message ?? "诗词阁加载失败");
      }
      setView((await gRes.json()) as GalleryView);
      if (rankRes.ok) {
        const rankBody = await rankRes.json().catch(() => null);
        if (typeof rankBody?.corpusTotal === "number") setCorpusTotal(rankBody.corpusTotal);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "诗词阁加载失败");
    }
  }, []);

  useEffect(() => {
    void load(page, dynFilter, gradeFilter);
  }, [load, page, dynFilter, gradeFilter]);

  const hasMore = useMemo(
    () => (view ? view.items.length === PAGE_SIZE : false),
    [view],
  );

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/play/poetry-rank" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 官途
        </Link>
        <div className="text-sm font-bold text-indigo-600">📚 诗词阁</div>
        <span className="w-10" />
      </div>

      {error ? (
        <div className="py-16 text-center">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      ) : !view ? (
        <div className="py-16 text-center">
          <p className="animate-pulse text-sm text-indigo-600">正在整理诗稿…</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 收集进度：total / 语料总数 */}
          <section className="rounded-2xl border border-indigo-100 bg-white p-4">
            <div className="flex items-baseline gap-3">
              <p className="text-3xl font-bold tabular-nums text-indigo-600">{view.total}</p>
              <p className="text-sm text-zinc-500">
                入阁诗
                {corpusTotal !== null ? <span> · 语料共 <span className="tabular-nums">{corpusTotal}</span> 首</span> : ""}
              </p>
              <p className="ml-auto text-xs text-zinc-400">
                {corpusTotal ? Math.min(100, Math.round((view.total / corpusTotal) * 100)) : "—"}%
              </p>
            </div>
          </section>

          {/* 朝代过滤条 */}
          {view.byDynasty.length > 0 && (
            <section>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">朝代</p>
              <div className="flex flex-wrap gap-1.5">
                {view.byDynasty.map((d) => {
                  const active = dynFilter === d.dynasty;
                  return (
                    <button
                      key={d.dynasty}
                      onClick={() => {
                        setPage(1);
                        setDynFilter(active ? null : d.dynasty);
                      }}
                      className={`rounded-full border px-2.5 py-1 text-xs ${
                        active
                          ? "border-indigo-500 bg-indigo-500 text-white"
                          : "border-indigo-200 bg-white text-indigo-600"
                      }`}
                    >
                      {d.dynasty} <span className="tabular-nums opacity-70">{d.count}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 学段过滤条 */}
          {view.byGrade.length > 0 && (
            <section>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">学段</p>
              <div className="flex flex-wrap gap-1.5">
                {view.byGrade.map((g) => {
                  const active = gradeFilter === g.grade;
                  return (
                    <button
                      key={g.grade}
                      onClick={() => {
                        setPage(1);
                        setGradeFilter(active ? null : g.grade);
                      }}
                      className={`rounded-full border px-2.5 py-1 text-xs ${
                        active
                          ? "border-amber-500 bg-amber-500 text-white"
                          : "border-amber-200 bg-white text-amber-600"
                      }`}
                    >
                      g{g.grade} <span className="tabular-nums opacity-70">{g.count}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 诗卡列表 */}
          <section className="space-y-2">
            {view.items.length === 0 ? (
              <div className="py-10 text-center text-sm text-zinc-400">
                暂无入阁诗——去研习一局，答过的诗都会收进阁里
              </div>
            ) : (
              view.items.map((it) => {
                const open = expanded === it.title;
                return (
                  <div
                    key={it.title}
                    className="rounded-xl border border-zinc-100 bg-white p-3"
                  >
                    <div
                      className="flex cursor-pointer items-center gap-2"
                      onClick={() => setExpanded(open ? null : it.title)}
                    >
                      <span className="text-lg">{open ? "▾" : "▸"}</span>
                      <span className="text-sm font-semibold text-zinc-800">{it.title}</span>
                      <span className="text-xs text-zinc-500">
                        {it.dynasty} · {it.poet} · g{it.grade}
                      </span>
                      {it.mastered && (
                        <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                          已通
                        </span>
                      )}
                    </div>
                    {open && (
                      <div className="mt-2 border-t border-zinc-50 pt-2">
                        {it.lines.map((line, i) => (
                          <p key={i} className="py-0.5 text-sm leading-relaxed text-zinc-700">
                            {line}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </section>

          {hasMore && (
            <button
              onClick={() => setPage((p) => p + 1)}
              className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 text-sm font-medium text-zinc-600 active:scale-[0.99]"
            >
              加载更多
            </button>
          )}

          <p className="text-center text-xs text-zinc-400">答过即入阁（不论对错）· 「已通」= 该诗至少答对过一次</p>
        </div>
      )}
    </main>
  );
}
