"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { PoetryStage } from "@/lib/games/poetry/types";
import { getRoundTimeMs } from "@/lib/games/timing";
import type { AnswerView, StartSessionView } from "@/lib/db/session-service";
import { usePoetryStore } from "@/store/poetry-store";
import { localPlayerId, usePlayerStore } from "@/store/player-store";
import { StagePicker } from "@/components/stage-picker";
import { SettleView } from "@/components/settle-view";
import { QuizHUD } from "@/components/quiz/quiz-hud";
import { ChoiceList } from "@/components/quiz/choice-list";
import { JudgeCard } from "@/components/quiz/judge-card";
import { useAutoNext } from "@/components/quiz/use-auto-next";
import { STAGE_LABEL } from "@/lib/games/stages";

const ROUND_TOTAL = 10;

export default function PoetryPage() {
  const s = usePoetryStore();
  const player = usePlayerStore();

  // 进入页面即初始化匿名玩家（幂等）
  useEffect(() => {
    void player.ensurePlayer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startGame = useCallback(async () => {
    usePoetryStore.getState().reset();
    usePoetryStore.setState({ phase: "LOADING" });
    try {
      // 有本地缓存 ID 直接用（省一次注册网络往返）；首次访问才等注册完成
      let playerId = usePlayerStore.getState().playerId ?? localPlayerId();
      if (!playerId) {
        await usePlayerStore.getState().ensurePlayer();
        playerId = usePlayerStore.getState().playerId;
      }
      const view = await secureFetch<StartSessionView>(
        "/api/games/poetry/session",
        { stage: usePoetryStore.getState().stage, count: ROUND_TOTAL, playerId: playerId ?? undefined },
      );
      usePoetryStore.getState().startGame(view);
    } catch (err) {
      usePoetryStore.getState().setError(err instanceof Error ? err.message : "开局失败，请重试");
    }
  }, []);

  // choice=null 且 timeout=true 表示倒计时耗尽未作答
  const answer = useCallback(async (choice: number | null, timeout = false) => {
    const st = usePoetryStore.getState();
    if (st.phase !== "PLAYING" || !st.gameSessionId || st.submitting) return;
    // 乐观选中态：点击立即高亮，不等判题往返
    usePoetryStore.setState({ submitting: true, ...(timeout ? {} : { selectedOption: choice }) });
    const timeMs = Date.now() - st.roundStartedAt;
    try {
      const judge = await secureFetch<AnswerView>("/api/games/poetry/answer", {
        gameSessionId: st.gameSessionId,
        roundIndex: st.currentIndex,
        timeMs,
        ...(timeout ? { timeout: true } : { choice: choice as number }),
      });
      usePoetryStore.getState().reveal(choice, judge);
    } catch (err) {
      usePoetryStore.getState().setError(err instanceof Error ? err.message : "提交失败，请重试");
    }
  }, []);

  // 判题后自动翻题（答对 0.7s / 答错 1.2s）
  useAutoNext({
    active: s.phase === "REVEAL",
    correct: s.lastJudge ? s.lastJudge.correct : null,
    onNext: s.next,
  });

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 返回
        </Link>
        <div className="text-sm font-medium">📜 诗词猜猜</div>
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
              mode="POETRY"
              progresses={player.progresses}
              selected={s.stage}
              onSelect={(stage) => s.setStage(stage as PoetryStage)}
            />
          </div>
          <button
            onClick={startGame}
            className="w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
          >
            开始挑战（10 题）
          </button>
          <p className="mt-4 text-center text-xs text-zinc-400">
            每题 15 秒 · 连击可叠加倍率 · 正确率 60% 通关解锁下一关
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
            durationMs={getRoundTimeMs(s.rounds[s.currentIndex].type)}
            active={s.phase === "PLAYING" && !s.submitting}
            theme="amber"
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
                  <p className="mb-2 text-sm text-zinc-500">{typeLabel}</p>
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
              theme="amber"
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
              theme="amber"
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
            modeLabel: "📜 诗词猜猜",
            stageLabel: STAGE_LABEL[s.stage],
          }}
          onRestart={startGame}
        />
      )}
    </main>
  );
}
