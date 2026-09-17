"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { ActorDifficulty, ActorQuestionType } from "@/lib/games/actor/types";
import { getRoundTimeMs } from "@/lib/games/timing";
import type {
  ActorAnswerView,
  StartActorSessionView,
} from "@/lib/db/actor-session-service";
import { useActorStore } from "@/store/actor-store";
import { localPlayerId, usePlayerStore } from "@/store/player-store";
import { StagePicker } from "@/components/stage-picker";
import { SettleView } from "@/components/settle-view";
import { QuizHUD } from "@/components/quiz/quiz-hud";
import { ChoiceList } from "@/components/quiz/choice-list";
import { JudgeCard } from "@/components/quiz/judge-card";
import { useAutoNext } from "@/components/quiz/use-auto-next";
import { STAGE_LABEL } from "@/lib/games/stages";

const ROUND_TOTAL = 10;

const QUESTION_LABEL: Record<ActorQuestionType, string> = {
  [ActorQuestionType.GUESS_FROM_WORKS]: "根据代表作，猜猜 TA 是谁？",
  [ActorQuestionType.GUESS_FROM_ROLES]: "根据经典角色，猜猜 TA 是谁？",
  [ActorQuestionType.GUESS_WORK]: "这个角色出自哪部作品？",
};

export default function ActorPage() {
  const s = useActorStore();
  const player = usePlayerStore();

  // 进入页面即初始化匿名玩家（幂等）
  useEffect(() => {
    void player.ensurePlayer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startGame = useCallback(async () => {
    useActorStore.getState().reset();
    useActorStore.setState({ phase: "LOADING" });
    try {
      // 有本地缓存 ID 直接用（省一次注册网络往返）；首次访问才等注册完成
      let playerId = usePlayerStore.getState().playerId ?? localPlayerId();
      if (!playerId) {
        await usePlayerStore.getState().ensurePlayer();
        playerId = usePlayerStore.getState().playerId;
      }
      const view = await secureFetch<StartActorSessionView>(
        "/api/games/actor/session",
        {
          difficulty: useActorStore.getState().difficulty,
          count: ROUND_TOTAL,
          playerId: playerId ?? undefined,
        },
      );
      useActorStore.getState().startGame(view);
    } catch (err) {
      useActorStore.getState().setError(err instanceof Error ? err.message : "开局失败，请重试");
    }
  }, []);

  // choice=null 且 timeout=true 表示倒计时耗尽未作答
  const answer = useCallback(async (choice: number | null, timeout = false) => {
    const st = useActorStore.getState();
    if (st.phase !== "PLAYING" || !st.gameSessionId || st.submitting) return;
    // 乐观选中态：点击立即高亮，不等判题往返
    useActorStore.setState({ submitting: true, ...(timeout ? {} : { selectedOption: choice }) });
    const timeMs = Date.now() - st.roundStartedAt;
    try {
      const judge = await secureFetch<ActorAnswerView>("/api/games/actor/answer", {
        gameSessionId: st.gameSessionId,
        roundIndex: st.currentIndex,
        timeMs,
        ...(timeout ? { timeout: true } : { choice: choice as number }),
      });
      useActorStore.getState().reveal(choice, judge);
    } catch (err) {
      useActorStore.getState().setError(err instanceof Error ? err.message : "提交失败，请重试");
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
        <div className="text-sm font-medium">🎬 演员猜猜</div>
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
              mode="ACTOR"
              progresses={player.progresses}
              selected={s.difficulty}
              onSelect={(stage) => s.setDifficulty(stage as ActorDifficulty)}
            />
          </div>
          <button
            onClick={startGame}
            className="w-full rounded-2xl bg-indigo-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
          >
            开始挑战（10 题）
          </button>
          <p className="mt-4 text-center text-xs text-zinc-400">
            每题 15 秒 · 只看作品与角色 · 正确率 60% 通关解锁下一关
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
            theme="indigo"
            onTimeout={() => void answer(null, true)}
          />

          <div key={s.currentIndex} className="animate-question-in">
            <p className="mb-2 text-sm text-zinc-500">
              {QUESTION_LABEL[s.rounds[s.currentIndex].type]}
            </p>
            <div className="mb-6 rounded-2xl border border-zinc-200 bg-white p-6 text-center">
              <p className="text-xl font-semibold leading-relaxed">
                {s.rounds[s.currentIndex].prompt}
              </p>
            </div>

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

      {s.phase === "FINISHED" && (
        <SettleView
          score={s.score}
          combo={s.combo}
          summary={s.lastSummary}
          cardBase={{
            nickname: player.nickname || "神秘玩家",
            avatar: player.avatar,
            modeLabel: "🎬 演员猜猜",
            stageLabel: STAGE_LABEL[s.difficulty],
          }}
          onRestart={startGame}
        />
      )}
    </main>
  );
}
