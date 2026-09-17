"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { FeihuaDifficulty, FeihuaQuestionType } from "@/lib/games/feihua/types";
import { getRoundTimeMs } from "@/lib/games/timing";
import type {
  FeihuaAnswerView,
  StartFeihuaSessionView,
} from "@/lib/db/feihua-session-service";
import { useFeihuaStore } from "@/store/feihua-store";
import { localPlayerId, usePlayerStore } from "@/store/player-store";
import { StagePicker } from "@/components/stage-picker";
import { SettleView } from "@/components/settle-view";
import { QuizHUD } from "@/components/quiz/quiz-hud";
import { ChoiceList } from "@/components/quiz/choice-list";
import { JudgeCard } from "@/components/quiz/judge-card";
import { useAutoNext } from "@/components/quiz/use-auto-next";
import { STAGE_LABEL } from "@/lib/games/stages";

const ROUND_TOTAL = 10;

const QUESTION_LABEL: Record<FeihuaQuestionType, string> = {
  [FeihuaQuestionType.FIND_CONTAINS]: "下列诗句中，哪一句含有令字？",
  [FeihuaQuestionType.FIND_MISSING]: "下列诗句中，哪一句不含令字？",
  [FeihuaQuestionType.GUESS_CHAR]: "这句诗可以飞哪个令字？",
};

export default function FeihuaPage() {
  const s = useFeihuaStore();
  const player = usePlayerStore();

  // 进入页面即初始化匿名玩家（幂等）
  useEffect(() => {
    void player.ensurePlayer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startGame = useCallback(async () => {
    useFeihuaStore.getState().reset();
    useFeihuaStore.setState({ phase: "LOADING" });
    try {
      // 有本地缓存 ID 直接用（省一次注册网络往返）；首次访问才等注册完成
      let playerId = usePlayerStore.getState().playerId ?? localPlayerId();
      if (!playerId) {
        await usePlayerStore.getState().ensurePlayer();
        playerId = usePlayerStore.getState().playerId;
      }
      const view = await secureFetch<StartFeihuaSessionView>(
        "/api/games/feihua/session",
        {
          difficulty: useFeihuaStore.getState().difficulty,
          count: ROUND_TOTAL,
          playerId: playerId ?? undefined,
        },
      );
      useFeihuaStore.getState().startGame(view);
    } catch (err) {
      useFeihuaStore.getState().setError(err instanceof Error ? err.message : "开局失败，请重试");
    }
  }, []);

  // choice=null 且 timeout=true 表示倒计时耗尽未作答
  const answer = useCallback(async (choice: number | null, timeout = false) => {
    const st = useFeihuaStore.getState();
    if (st.phase !== "PLAYING" || !st.gameSessionId || st.submitting) return;
    // 乐观选中态：点击立即高亮，不等判题往返
    useFeihuaStore.setState({ submitting: true, ...(timeout ? {} : { selectedOption: choice }) });
    const timeMs = Date.now() - st.roundStartedAt;
    try {
      const judge = await secureFetch<FeihuaAnswerView>("/api/games/feihua/answer", {
        gameSessionId: st.gameSessionId,
        roundIndex: st.currentIndex,
        timeMs,
        ...(timeout ? { timeout: true } : { choice: choice as number }),
      });
      useFeihuaStore.getState().reveal(choice, judge);
    } catch (err) {
      useFeihuaStore.getState().setError(err instanceof Error ? err.message : "提交失败，请重试");
    }
  }, []);

  // 判题后自动翻题（答对 0.7s / 答错 1.2s）
  useAutoNext({
    active: s.phase === "REVEAL",
    correct: s.lastJudge ? s.lastJudge.correct : null,
    onNext: s.next,
  });

  const round = s.rounds[s.currentIndex];
  const isGuessChar = round?.type === FeihuaQuestionType.GUESS_CHAR;

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 返回
        </Link>
        <div className="text-sm font-medium">🌸 飞花令</div>
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
              mode="FEIHUA"
              progresses={player.progresses}
              selected={s.difficulty}
              onSelect={(stage) => s.setDifficulty(stage as FeihuaDifficulty)}
            />
          </div>
          <button
            onClick={startGame}
            className="w-full rounded-2xl bg-rose-500 py-4 text-lg font-bold text-white shadow active:scale-[0.99]"
          >
            开始挑战（10 题）
          </button>
          <p className="mt-4 text-center text-xs text-zinc-400">
            每题 15 秒 · 含字寻句 / 无字挑白 / 据句猜令 · 正确率 60% 通关解锁下一关
          </p>
        </section>
      )}

      {(s.phase === "LOADING" || s.phase === "ERROR") && (
        <section className="py-20 text-center">
          {s.phase === "LOADING" ? (
            <p className="animate-pulse text-zinc-500">正在飞花…</p>
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
            theme="rose"
            onTimeout={() => void answer(null, true)}
          />

          <div key={s.currentIndex} className="animate-question-in">
            <p className="mb-2 text-sm text-zinc-500">{QUESTION_LABEL[round.type]}</p>

            {isGuessChar ? (
              <div className="mb-6 rounded-2xl border border-zinc-200 bg-white p-6 text-center">
                <p className="text-xl font-semibold leading-relaxed">{round.prompt}</p>
              </div>
            ) : (
              <div className="mb-6 rounded-2xl border border-rose-200 bg-gradient-to-b from-rose-50 to-white p-6 text-center">
                <p className="mb-2 text-xs font-medium tracking-widest text-rose-400">
                  令 字
                </p>
                <p className="text-6xl font-bold leading-tight text-rose-500">
                  {round.lingChar}
                </p>
              </div>
            )}

            <ChoiceList
              options={round.options}
              selected={s.selectedOption}
              correctAnswer={s.lastJudge?.correctAnswer ?? null}
              reveal={s.phase === "REVEAL"}
              locked={s.submitting}
              theme="rose"
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
              theme="rose"
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
            modeLabel: "🌸 飞花令",
            stageLabel: STAGE_LABEL[s.difficulty],
          }}
          onRestart={startGame}
        />
      )}
    </main>
  );
}
