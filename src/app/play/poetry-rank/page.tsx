"use client";

/**
 * 诗词升官 · 官途页（阶段 C 前端）
 *
 * - 官途主页：路线图 + 功名条 + 研习/科考入口（功名不达标时科考置灰并注明缺口）
 * - 对局：复用 quiz 组件（HUD 倒计时 / 选项 / 判题反馈 / 自动翻题），indigo 主题
 * - 结算：功名入账 + 晋升结果 + 失败重考 + 缺题提示
 * - 刷新恢复：进入页面先查未完成官阶局，从首个未答轮次继续
 *
 * 权威数据（功名/官阶/判题）均来自服务端；DB 不可用时 503 提示，不做内存兜底。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { getRoundTimeMs } from "@/lib/games/timing";
import type { RankKind } from "@/lib/games/poetry/types";
import type {
  RankedJudgeView,
  RankedResumeView,
  RankedStartView,
  RankView,
} from "@/lib/db/rank-service";
import { useRankGameStore } from "@/store/rank-store";
import { localPlayerId, usePlayerStore } from "@/store/player-store";
import { RankRoad } from "@/components/rank/rank-road";
import { RankSettleView } from "@/components/rank/rank-settle-view";
import { QuizHUD } from "@/components/quiz/quiz-hud";
import { ChoiceList } from "@/components/quiz/choice-list";
import { JudgeCard } from "@/components/quiz/judge-card";
import { useAutoNext } from "@/components/quiz/use-auto-next";

const KIND_LABEL: Record<RankKind, string> = {
  PRACTICE: "研习",
  EXAM: "科考",
  DAILY: "每日题",
};

export default function PoetryRankPage() {
  const s = useRankGameStore();
  const [rank, setRank] = useState<RankView | null>(null);
  const [loadingRank, setLoadingRank] = useState(true);

  // 拉取官阶视图（功名条 / 路线图数据源）
  const loadRank = useCallback(async (): Promise<RankView | null> => {
    let pid = usePlayerStore.getState().playerId ?? localPlayerId();
    if (!pid) {
      await usePlayerStore.getState().ensurePlayer();
      pid = usePlayerStore.getState().playerId;
    }
    if (!pid) return null;
    try {
      const res = await fetch(`/api/games/poetry/rank?playerId=${encodeURIComponent(pid)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? "官阶视图加载失败");
      }
      const view = (await res.json()) as RankView;
      setRank(view);
      return view;
    } catch {
      return null;
    }
  }, []);

  // 进入页面：初始化玩家 → 拉官阶 → 尝试刷新恢复未完成官阶局
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 后台刷新玩家档案（幂等；store 未落盘时从 localStorage 取 id 补档）。
      void usePlayerStore.getState().ensurePlayer();
      const view = await loadRank();
      if (cancelled) return;
      setLoadingRank(false);
      if (!view) return;
      // 与 loadRank / startGame 同口径：store 未落盘时回落到 localStorage 同步读。
      // 不能只读 usePlayerStore.getState().playerId——ensurePlayer 的落盘是异步的，
      // 仅读 store 会在刷新恢复时拿到 null 而静默跳过 resume。
      const pid = usePlayerStore.getState().playerId ?? localPlayerId();
      if (!pid) return;
      try {
        const resumed = await secureFetch<Partial<RankedResumeView>>(
          "/api/games/poetry/rank/resume",
          { playerId: pid },
        );
        if (cancelled || !resumed.gameSessionId) return;
        useRankGameStore.getState().resume(resumed as RankedResumeView, view);
      } catch {
        /* 无未完成对局或网络失败：回落到官途主页 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 开局（研习 / 科考）
  const startGame = useCallback(
    async (kind: "PRACTICE" | "EXAM") => {
      const st = useRankGameStore.getState();
      st.reset();
      useRankGameStore.setState({ phase: "LOADING", kind });
      try {
        let pid = usePlayerStore.getState().playerId ?? localPlayerId();
        if (!pid) {
          await usePlayerStore.getState().ensurePlayer();
          pid = usePlayerStore.getState().playerId;
        }
        if (!pid) throw new Error("玩家初始化失败，请重试");
        const view = await secureFetch<RankedStartView>(
          "/api/games/poetry/rank/start",
          { playerId: pid, kind },
        );
        useRankGameStore.getState().startGame(view);
      } catch (err) {
        useRankGameStore.getState().setError(
          err instanceof Error ? err.message : "开局失败，请重试",
        );
      }
    },
    [],
  );

  // 作答（choice=null 且 timeout=true 表示倒计时耗尽）
  const answer = useCallback(async (choice: number | null, timeout = false) => {
    const st = useRankGameStore.getState();
    if (st.phase !== "PLAYING" || !st.gameSessionId || st.submitting) return;
    useRankGameStore.setState({
      submitting: true,
      ...(timeout ? {} : { selectedOption: choice }),
    });
    const timeMs = Date.now() - st.roundStartedAt;
    try {
      const judge = await secureFetch<RankedJudgeView>(
        "/api/games/poetry/rank/answer",
        {
          gameSessionId: st.gameSessionId,
          roundIndex: st.currentIndex,
          timeMs,
          ...(timeout ? { timeout: true } : { choice: choice as number }),
        },
      );
      useRankGameStore.getState().reveal(choice, judge);
    } catch (err) {
      useRankGameStore.getState().setError(
        err instanceof Error ? err.message : "提交失败，请重试",
      );
    }
  }, []);

  // 判题后自动翻题
  useAutoNext({
    active: s.phase === "REVEAL",
    correct: s.lastJudge ? s.lastJudge.correct : null,
    onNext: s.next,
  });

  // 结算后刷新官阶视图（功名条回主页展示最新值）
  useEffect(() => {
    if (s.phase === "FINISHED" && s.lastSummary) {
      setRank(s.lastSummary.rank);
    }
  }, [s.phase, s.lastSummary]);

  const goHome = () => {
    useRankGameStore.getState().reset();
    void loadRank();
  };

  const examReady = rank ? rank.nextUnlocked : false;
  const isEmperorNow = rank ? rank.ranks[rank.rankId]?.isEmperor : false;

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/play/poetry" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 学段闯关
        </Link>
        <div className="text-sm font-medium">🎓 诗词升官</div>
        {s.phase !== "IDLE" && s.gameSessionId && (
          <div className="text-sm">
            <span className="text-zinc-400">{KIND_LABEL[s.kind]}</span> 得分{" "}
            <span className="font-bold tabular-nums">{s.score}</span>
          </div>
        )}
      </div>

      {/* 官途主页 */}
      {s.phase === "IDLE" && (
        <section>
          {loadingRank || !rank ? (
            <div className="py-20 text-center">
              <p className="animate-pulse text-zinc-500">正在查询官途…</p>
            </div>
          ) : (
            <>
              <RankRoad rank={rank} />

              <div className="mt-6 grid gap-3">
                <button
                  onClick={() => void startGame("PRACTICE")}
                  className="w-full rounded-2xl bg-indigo-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
                >
                  📖 研习（{rank.label}窗口 · 10 题 · 积功名）
                </button>

                {isEmperorNow ? (
                  <button
                    onClick={() => void startGame("EXAM")}
                    className="w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
                  >
                    👑 登极大考（15 题）
                  </button>
                ) : (
                  <button
                    onClick={() => void startGame("EXAM")}
                    disabled={!examReady}
                    className={
                      examReady
                        ? "w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
                        : "w-full rounded-2xl border border-zinc-300 bg-zinc-100 py-4 text-zinc-400"
                    }
                  >
                    📜 科考（晋升一阶 · 10 题）
                    {!examReady && rank.expToNext > 0 && (
                      <span className="mt-1 block text-xs">
                        还差 {rank.expToNext} 功名
                      </span>
                    )}
                  </button>
                )}
              </div>

              <p className="mt-4 text-center text-xs text-zinc-400">
                已见题永久去重 · 正确率 60% 通过科考擢升 · 架空称号路线
              </p>
            </>
          )}
        </section>
      )}

      {/* 出题中 / 出错 */}
      {(s.phase === "LOADING" || s.phase === "ERROR") && (
        <section className="py-20 text-center">
          {s.phase === "LOADING" ? (
            <p className="animate-pulse text-zinc-500">
              正在出题（{KIND_LABEL[s.kind]}）…
            </p>
          ) : (
            <>
              <p className="mb-2 text-red-500">{s.error}</p>
              {s.error.includes("容量不足") || s.error.includes("题库为空") ? (
                <p className="mb-4 text-xs text-zinc-400">
                  本窗口题目已出完，进度已保留；等待语料扩容后可继续
                </p>
              ) : null}
              <button
                onClick={goHome}
                className="rounded-xl border border-zinc-300 px-6 py-2"
              >
                返回官途
              </button>
            </>
          )}
        </section>
      )}

      {/* 对局 */}
      {(s.phase === "PLAYING" || s.phase === "REVEAL") && s.rounds.length > 0 && (
        <section>
          <QuizHUD
            index={s.currentIndex}
            total={s.rounds.length}
            combo={s.combo}
            roundStartedAt={s.roundStartedAt}
            durationMs={getRoundTimeMs(s.rounds[s.currentIndex]?.type)}
            active={s.phase === "PLAYING" && !s.submitting}
            theme="indigo"
            onTimeout={() => void answer(null, true)}
          />

          <div key={s.currentIndex} className="animate-question-in">
            {(() => {
              const round = s.rounds[s.currentIndex];
              const typeLabel =
                round.type === "GUESS_POET"
                  ? "这句诗的作者是？"
                  : round.type === "GUESS_TITLE"
                    ? "这句诗出自哪首作品？"
                    : "请补出下一句";
              return (
                <>
                  <p className="mb-2 text-sm text-zinc-500">
                    {KIND_LABEL[s.kind]} · 第 {s.currentIndex + 1} 题 · {typeLabel}
                  </p>
                  <div className="mb-6 rounded-2xl border border-zinc-200 bg-white p-6 text-center">
                    <p className="text-xl font-semibold leading-relaxed">
                      {round.prompt}
                    </p>
                  </div>
                </>
              );
            })()}

            <ChoiceList
              options={s.rounds[s.currentIndex].options}
              selected={s.selectedOption}
              correctAnswer={s.lastJudge?.correctAnswer ?? null}
              reveal={s.phase === "REVEAL"}
              locked={s.submitting}
              theme="indigo"
              onChoose={(i) => void answer(i)}
            />
          </div>

          {s.phase === "REVEAL" && s.lastJudge && (
            <JudgeCard
              correct={s.lastJudge.correct}
              timeout={s.lastJudge.timeout}
              correctAnswer={s.lastJudge.correctAnswer}
              explanation={s.lastJudge.explanation}
              gained={s.lastJudge.gained}
              multiplier={s.lastJudge.multiplier}
              isLast={s.currentIndex + 1 >= s.rounds.length}
              theme="indigo"
              onNext={s.next}
            />
          )}
        </section>
      )}

      {/* 结算 */}
      {s.phase === "FINISHED" && s.lastSummary && (
        <RankSettleView
          summary={s.lastSummary}
          onBack={goHome}
          onRetry={
            s.lastSummary.kind === "EXAM" && s.lastSummary.promotion.reason === "EXAM_FAILED"
              ? () => void startGame("EXAM")
              : undefined
          }
        />
      )}
    </main>
  );
}
