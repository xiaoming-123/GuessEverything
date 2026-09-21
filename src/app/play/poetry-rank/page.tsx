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
import { buildGuessOptions, isGuessAvailable } from "@/lib/games/poetry/guess";
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
import { RankIdentityCard } from "@/components/rank/rank-identity-card";
import { RankSettleView } from "@/components/rank/rank-settle-view";
import { PersonaBubble } from "@/components/rank/persona-bubble";
import { QuizHUD } from "@/components/quiz/quiz-hud";
import { DialogueChoices } from "@/components/quiz/dialogue-choices";
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

  // 开局（研习 / 科考 / 每日题）
  const startGame = useCallback(
    async (kind: "PRACTICE" | "EXAM" | "DAILY") => {
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

  // 剪影竞猜状态（D4 详设 §4.2）：本地记录当次点击结果，权威状态以 GET rank.guess 为准
  const [guessResult, setGuessResult] = useState<{ correct: boolean; gained: number } | null>(null);
  const [guessBusy, setGuessBusy] = useState(false);

  // 问同窗（D4 详设 §4.1）：一局一次，移除 2 个错误选项（非 Hook 命名，避免 rules-of-hooks 误报）
  const askHint = useCallback(async () => {
    const st = useRankGameStore.getState();
    if (st.phase !== "PLAYING" || !st.gameSessionId || st.hintUsed) return;
    try {
      const res = await secureFetch<{ removedIndexes: number[] }>(
        "/api/games/poetry/rank/hint",
        {
          playerId: usePlayerStore.getState().playerId ?? localPlayerId(),
          gameSessionId: st.gameSessionId,
          roundIndex: st.currentIndex,
        },
      );
      useRankGameStore.getState().applyHint({
        roundIndex: st.currentIndex,
        removedIndexes: res.removedIndexes,
      });
    } catch {
      /* 已用过 / 超时：忽略（按钮已置灰） */
    }
  }, []);

  // 剪影竞猜提交（猜 rankId+2 迷雾阶称号）
  const submitGuess = useCallback(
    async (label: string) => {
      if (rank?.guess?.done || guessBusy) return;
      const pid = usePlayerStore.getState().playerId ?? localPlayerId();
      if (!pid) return;
      setGuessBusy(true);
      try {
        const res = await secureFetch<{ correct: boolean; gained: number; todayUsed: boolean }>(
          "/api/games/poetry/rank/guess",
          { playerId: pid, guessLabel: label },
        );
        setGuessResult({ correct: res.correct, gained: res.gained });
        void loadRank(); // 刷新 rank.guess 权威态
      } catch {
        /* 403 无迷雾阶 / 网络失败：忽略 */
      } finally {
        setGuessBusy(false);
      }
    },
    [rank?.guess?.done, guessBusy, loadRank],
  );


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
  // 每日题今日状态（详设 §2.1 月历口径：done/made=已答，pending=未答）
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const todayCell = rank?.daily.cells.find((c) => c && c.date === today) ?? null;
  const dailyDone = todayCell ? todayCell.state === "done" || todayCell.state === "made" : false;

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 返回首页
        </Link>
        <div className="text-sm font-medium">🎓 诗词升官</div>
        {s.phase === "IDLE" ? (
          <Link
            href="/play/poetry-rank/leaderboard"
            className="text-sm font-medium text-amber-600 hover:text-amber-700"
          >
            📜 皇榜
          </Link>
        ) : (
          s.gameSessionId && (
            <div className="text-sm">
              <span className="text-zinc-400">{KIND_LABEL[s.kind]}</span> 得分{" "}
              <span className="font-bold tabular-nums">{s.score}</span>
            </div>
          )
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
              {/* 身份卡（D1：立绘 + 称号 + 功名估算 + 最近战绩） */}
              <RankIdentityCard rank={rank} />

              {/* 路线图迷雾（D1 重写） */}
              <div className="mt-4">
                <RankRoad rank={rank} />
              </div>

              {/* 剪影竞猜（D4 详设 §4.2）：猜 rankId+2 迷雾阶称号，每日 1 次 +100。
                  rankId>=8（侍郎及以上）时入口整体隐藏（服务端 guess=null + 前端不渲染）。 */}
              {rank.guess !== null && isGuessAvailable(rank.rankId) && (() => {
                const seed = (rank.rankId + 1) * 7919;
                const opts = buildGuessOptions(rank.rankId, seed);
                const done = rank.guess.done;
                const showResult = done || guessResult !== null;
                const resCorrect = done ? rank.guess.correct : guessResult?.correct;
                return (
                  <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <p className="mb-1 text-sm font-bold text-amber-700">
                      🔮 剪影竞猜：猜猜再下一阶（迷雾阶）的官衔？
                    </p>
                    <p className="mb-3 text-xs text-amber-600/80">
                      每日 1 次
                    </p>
                    {opts && (
                      <div className="grid grid-cols-2 gap-2">
                        {opts.options.map((label, i) => {
                          const isAnswer = showResult && label === opts.answerLabel;
                          let cls = "border-amber-200 bg-white text-amber-700 active:scale-[0.98]";
                          if (done) cls = "border-amber-200 bg-white text-amber-500";
                          if (showResult && isAnswer) cls = "border-emerald-500 bg-emerald-50 font-bold text-emerald-700";
                          return (
                            <button
                              key={i}
                              type="button"
                              disabled={done || guessBusy}
                              onClick={() => void submitGuess(label)}
                              className={`rounded-xl border px-3 py-2 text-sm font-bold transition ${cls}`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {showResult && (
                      <p className="mt-3 text-sm font-bold">
                        {resCorrect ? (
                          <span className="text-emerald-600">✅ 猜中了！</span>
                        ) : (
                          <span className="text-zinc-500">未中（明日再试）</span>
                        )}
                      </p>
                    )}
                  </div>
                );
              })()}

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
                        功名尚在积攒中
                      </span>
                    )}
                  </button>
                )}

                <button
                  onClick={() => void startGame("DAILY")}
                  disabled={dailyDone}
                  className={
                    dailyDone
                      ? "w-full rounded-2xl border border-emerald-200 bg-emerald-50 py-3 text-sm font-bold text-emerald-600"
                      : "w-full rounded-2xl bg-emerald-500 py-3 text-base font-bold text-white shadow active:scale-[0.99]"
                  }
                >
                  {dailyDone ? "✅ 每日题已完成" : "🌱 每日题（1 题 · 积功名 · 连满得周奖）"}
                </button>

                <Link
                  href="/play/poetry-rank/ledger"
                  className="w-full rounded-2xl border border-indigo-200 bg-white py-3 text-center text-sm font-bold text-indigo-600 active:scale-[0.99]"
                >
                  🏮 功名簿（成就 · 月历 · 总览）
                </Link>

                <Link
                  href="/play/poetry-rank/gallery"
                  className="w-full rounded-2xl border border-emerald-200 bg-white py-3 text-center text-sm font-bold text-emerald-600 active:scale-[0.99]"
                >
                  📚 诗词阁（收集答过的诗）
                </Link>
              </div>

              <p className="mt-4 text-center text-xs text-zinc-400">
                研习积功名 · 科考擢升 · 架空称号路线
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
              // 首题展示开局白；后续题用简短过场句（人设对话气泡化，详设 §1.3）
              const bubbleText =
                s.currentIndex === 0 && s.opening
                  ? s.opening
                  : "下一题。";
              return (
                <PersonaBubble
                  persona={s.persona ?? "TUTOR"}
                  variant="question"
                  text={bubbleText}
                  typeLabel={`${KIND_LABEL[s.kind]} · 第 ${s.currentIndex + 1} 题 · ${typeLabel}`}
                  prompt={round.prompt}
                  combo={s.combo}
                />
              );
            })()}

            <div className="mt-4">
              <DialogueChoices
                options={s.rounds[s.currentIndex].options}
                selected={s.selectedOption}
                correctAnswer={s.lastJudge?.correctAnswer ?? null}
                reveal={s.phase === "REVEAL"}
                locked={s.submitting}
                theme="indigo"
                onChoose={(i) => void answer(i)}
                removedIndexes={
                  s.hint && s.hint.roundIndex === s.currentIndex
                    ? s.hint.removedIndexes
                    : undefined
                }
              />
            </div>

            {/* 问同窗（D4 详设 §4.1）：一局一次，移除 2 个错误选项（不泄答案） */}
            {s.phase === "PLAYING" && (
              <button
                type="button"
                onClick={() => void askHint()}
                disabled={s.hintUsed || s.submitting}
                className={
                  s.hintUsed
                    ? "mt-3 w-full rounded-xl border border-zinc-200 bg-zinc-50 py-2 text-sm text-zinc-400"
                    : "mt-3 w-full rounded-xl border border-indigo-200 bg-white py-2 text-sm font-bold text-indigo-600 active:scale-[0.99]"
                }
              >
                {s.hintUsed
                  ? "💡 已问过同窗"
                  : "💡 问同窗（移除 2 个错误选项）"}
              </button>
            )}

            {s.phase === "REVEAL" && s.lastJudge && s.persona && (
              <div className="animate-reveal-in mt-4">
                <PersonaBubble
                  persona={s.persona}
                  variant="feedback"
                  text={s.lastJudge.feedback}
                  correctAnswer={s.lastJudge.correctAnswer}
                  gained={s.lastJudge.gained}
                  isLast={s.currentIndex + 1 >= s.rounds.length}
                  onNext={s.next}
                />
              </div>
            )}
          </div>
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
