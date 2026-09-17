"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { ObjectDifficulty, ObjectQuestionType } from "@/lib/games/object/types";
import { getRoundTimeMs } from "@/lib/games/timing";
import type {
  ObjectAnswerView,
  StartObjectSessionView,
} from "@/lib/db/object-session-service";
import { useObjectStore } from "@/store/object-store";
import { localPlayerId, usePlayerStore } from "@/store/player-store";
import { StagePicker } from "@/components/stage-picker";
import { SettleView } from "@/components/settle-view";
import { QuizHUD } from "@/components/quiz/quiz-hud";
import { ChoiceList } from "@/components/quiz/choice-list";
import { JudgeCard } from "@/components/quiz/judge-card";
import { useAutoNext } from "@/components/quiz/use-auto-next";
import { STAGE_LABEL } from "@/lib/games/stages";

const ROUND_TOTAL = 10;

export default function ObjectPage() {
  const s = useObjectStore();
  const player = usePlayerStore();

  // 进入页面即初始化匿名玩家（幂等）
  useEffect(() => {
    void player.ensurePlayer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startGame = useCallback(async () => {
    useObjectStore.getState().reset();
    useObjectStore.setState({ phase: "LOADING" });
    try {
      // 有本地缓存 ID 直接用（省一次注册网络往返）；首次访问才等注册完成
      let playerId = usePlayerStore.getState().playerId ?? localPlayerId();
      if (!playerId) {
        await usePlayerStore.getState().ensurePlayer();
        playerId = usePlayerStore.getState().playerId;
      }
      const view = await secureFetch<StartObjectSessionView>(
        "/api/games/object/session",
        {
          difficulty: useObjectStore.getState().difficulty,
          count: ROUND_TOTAL,
          playerId: playerId ?? undefined,
        },
      );
      useObjectStore.getState().startGame(view);
    } catch (err) {
      useObjectStore.getState().setError(err instanceof Error ? err.message : "开局失败，请重试");
    }
  }, []);

  // choice=null 且 timeout=true 表示倒计时耗尽未作答
  const answer = useCallback(async (choice: number | null, timeout = false) => {
    const st = useObjectStore.getState();
    if (st.phase !== "PLAYING" || !st.gameSessionId || st.submitting) return;
    // 乐观选中态：点击立即高亮，不等判题往返
    useObjectStore.setState({ submitting: true, ...(timeout ? {} : { selectedOption: choice }) });
    const timeMs = Date.now() - st.roundStartedAt;
    try {
      const judge = await secureFetch<ObjectAnswerView>("/api/games/object/answer", {
        gameSessionId: st.gameSessionId,
        roundIndex: st.currentIndex,
        timeMs,
        revealedClues: st.revealedClues,
        ...(timeout ? { timeout: true } : { choice: choice as number }),
      });
      useObjectStore.getState().reveal(choice, judge);
    } catch (err) {
      useObjectStore.getState().setError(err instanceof Error ? err.message : "提交失败，请重试");
    }
  }, []);

  // 判题后自动翻题（答对 0.7s / 答错 1.2s）
  useAutoNext({
    active: s.phase === "REVEAL",
    correct: s.lastJudge ? s.lastJudge.correct : null,
    onNext: s.next,
  });

  const round = s.rounds[s.currentIndex];
  const isReveal = s.phase === "REVEAL";
  const isRiddle = round?.type === ObjectQuestionType.GUESS_FROM_RIDDLE;
  const isClueRound = round?.type === ObjectQuestionType.GUESS_FROM_CLUES;
  const questionLabel =
    round?.type === ObjectQuestionType.GUESS_CATEGORY
      ? "它属于哪一类？"
      : isRiddle
        ? "猜一民间事物（谜语）"
        : "根据线索，猜猜它是什么？";
  // 线索题：作答中按已揭示条数展示，判题后展示全部
  const visibleClues = round
    ? isClueRound
      ? round.clues.slice(0, isReveal ? round.clues.length : s.revealedClues)
      : round.clues
    : [];
  const canRevealMore =
    !isReveal && !s.submitting && isClueRound && round !== undefined && s.revealedClues < round.clues.length;

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 返回
        </Link>
        <div className="text-sm font-medium">🎁 物品猜猜</div>
        {s.phase !== "IDLE" && (
          <div className="text-sm">
            得分 <span className="font-bold tabular-nums">{s.score}</span>
          </div>
        )}
      </div>

      {s.phase === "IDLE" && (
        <section>
          <p className="mb-3 text-zinc-500">选择关卡</p>
          <div className="mb-8">
            <StagePicker
              mode="OBJECT"
              progresses={player.progresses}
              selected={s.difficulty}
              onSelect={(stage) => s.setDifficulty(stage as ObjectDifficulty)}
            />
          </div>
          <button
            onClick={startGame}
            className="w-full rounded-2xl bg-emerald-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
          >
            开始挑战（10 题）
          </button>
          <p className="mt-4 text-center text-xs text-zinc-400">
            普通题 15 秒 · 谜语 20 秒 · 求助线索每条 -30 分
          </p>
        </section>
      )}

      {(s.phase === "LOADING" || s.phase === "ERROR") && (
        <section className="py-20 text-center">
          {s.phase === "LOADING" ? (
            <p className="animate-pulse text-zinc-500">正在出题…</p>
          ) : (
            <>
              <p className="mb-4 text-red-500">{s.error}</p>
              <button
                onClick={() => s.reset()}
                className="rounded-xl border border-zinc-300 px-6 py-2"
              >
                返回
              </button>
            </>
          )}
        </section>
      )}

      {(s.phase === "PLAYING" || s.phase === "REVEAL") && s.rounds.length > 0 && (
        <section>
          <QuizHUD
            index={s.currentIndex}
            total={s.rounds.length}
            combo={s.combo}
            roundStartedAt={s.roundStartedAt}
            durationMs={getRoundTimeMs(round.type)}
            active={s.phase === "PLAYING" && !s.submitting}
            theme="emerald"
            onTimeout={() => void answer(null, true)}
          />

          <div key={s.currentIndex} className="animate-question-in">
            <p className="mb-2 text-sm text-zinc-500">{questionLabel}</p>
            <div className="mb-3 rounded-2xl border border-zinc-200 bg-white p-6">
              {isRiddle ? (
                <p className="whitespace-pre-line text-center text-xl font-semibold leading-relaxed">
                  {visibleClues[0]}
                </p>
              ) : (
                <ul className="grid gap-2">
                  {visibleClues.map((clue, i) => (
                    <li
                      key={i}
                      className="animate-question-in flex gap-2 text-base leading-relaxed text-zinc-700"
                    >
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-600">
                        {i + 1}
                      </span>
                      <span>{clue}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {canRevealMore && (
              <button
                type="button"
                onClick={s.revealMoreClue}
                className="mb-4 w-full rounded-xl border border-dashed border-emerald-300 py-2 text-sm font-medium text-emerald-600 active:scale-[0.99]"
              >
                💡 再给一条线索（-30 分）
              </button>
            )}

            <ChoiceList
              options={round.options}
              selected={s.selectedOption}
              correctAnswer={s.lastJudge?.correctAnswer ?? null}
              reveal={isReveal}
              locked={s.submitting}
              theme="emerald"
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
              theme="emerald"
              onNext={s.next}
            />
          )}
        </section>
      )}

      {s.phase === "FINISHED" && (
        <SettleView
          score={s.score}
          combo={s.combo}
          summary={s.lastSummary}
          cardBase={{
            nickname: player.nickname || "神秘玩家",
            avatar: player.avatar,
            modeLabel: "🎁 物品猜猜",
            stageLabel: STAGE_LABEL[s.difficulty],
          }}
          onRestart={startGame}
        />
      )}
    </main>
  );
}
