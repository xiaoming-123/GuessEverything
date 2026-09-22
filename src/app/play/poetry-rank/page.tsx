"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { getRoundTimeMs } from "@/lib/games/timing";
import { buildGuessOptions, isGuessAvailable } from "@/lib/games/poetry/guess";
import { EVENT_BY_ID } from "@/lib/games/poetry/events";
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
import { ShareCardView } from "@/components/share-card-view";
import { ACHIEVEMENT_BY_KEY } from "@/lib/games/poetry/achievements";
import { QuizHUD } from "@/components/quiz/quiz-hud";
import { AdaptiveChoice } from "@/components/quiz/adaptive-choice";
import { useAutoNext } from "@/components/quiz/use-auto-next";
import {
  GameShell,
  Modal,
  PagedItems,
  PagedText,
  StatusView,
} from "@/components/game-ui";
import { BRAND } from "@/lib/brand";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

const KIND_LABEL: Record<RankKind, string> = {
  PRACTICE: "研习",
  EXAM: "科考",
  DAILY: "每日题",
};
const PROLOGUE_KEY = "rebirth-prologue:v1";
const QUESTION_LABEL: Record<string, string> = {
  GUESS_POET: "这句诗的作者是？",
  GUESS_TITLE: "这句诗出自哪首作品？",
  COMPLETE_NEXT: "请接出下一句",
  FILL_CHAR: "哪一个字，恰好填入空缺？",
  DYNASTY_PICK: "这句诗出自哪个朝代？",
};

function EventLine({ event }: { event: RankView["event"] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (!event || event.endsAt <= now)
    return (
      <div className="event-slot">
        <span>一字一句，皆是向上的阶梯。</span>
        <span aria-hidden="true">✧</span>
      </div>
    );
  const minutes = Math.max(0, Math.ceil((event.endsAt - now) / 60_000));
  return (
    <div className="event-slot">
      <span>
        {event.name} · 研习功名 ×{event.expMultiplier}
      </span>
      <span>
        {Math.floor(minutes / 60)}时{minutes % 60}分
      </span>
    </div>
  );
}

export default function PoetryRankPage() {
  const s = useRankGameStore();
  const [rank, setRank] = useState<RankView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [panel, setPanel] = useState<
    "more" | "guess" | "prologue" | "feedback" | "record" | "option" | null
  >(null);
  const [readingOption, setReadingOption] = useState(0);
  const [guessResult, setGuessResult] = useState<{
    correct: boolean;
    gained: number;
  } | null>(null);
  const [guessBusy, setGuessBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [hintBusy, setHintBusy] = useState(false);
  const initialization = useRef(0);

  const loadRank = useCallback(async () => {
    await usePlayerStore.getState().ensurePlayer();
    const pid = usePlayerStore.getState().playerId ?? localPlayerId();
    if (!pid) throw new Error("暂时无法连接书院，请检查网络后重试。");
    const res = await fetchWithTimeout(
      `/api/games/poetry/rank?playerId=${encodeURIComponent(pid)}`,
      { cache: "no-store" },
    );
    if (!res.ok) throw new Error("官途暂未载入，已有进度不会丢失，请重试。");
    const view = (await res.json()) as RankView;
    setRank(view);
    return { view, pid };
  }, []);

  const initialize = useCallback(async () => {
    const version = ++initialization.current;
    setLoading(true);
    setLoadError("");
    try {
      const { view, pid } = await loadRank();
      if (version !== initialization.current) return;
      const existing = useRankGameStore.getState();
      if (["PLAYING", "REVEAL", "FINISHED"].includes(existing.phase)) return;
      const resumed = await secureFetch<Partial<RankedResumeView>>(
        "/api/games/poetry/rank/resume",
        { playerId: pid },
      );
      if (version !== initialization.current) return;
      if (resumed.gameSessionId) {
        useRankGameStore.getState().resume(resumed as RankedResumeView, view);
        return;
      }
      useRankGameStore.getState().reset();
      try {
        if (!localStorage.getItem(PROLOGUE_KEY)) setPanel("prologue");
      } catch {
        /* 存储不可用仍能游玩 */
      }
    } catch {
      if (version === initialization.current)
        setLoadError("官途暂未载入，请检查网络后重试。进度会为你保留。");
    } finally {
      if (version === initialization.current) setLoading(false);
    }
  }, [loadRank]);
  useEffect(() => {
    void initialize();
    const version = initialization.current;
    return () => {
      initialization.current = version + 1;
    };
  }, [initialize]);

  const startGame = async (kind: RankKind) => {
    if (useRankGameStore.getState().phase === "LOADING") return;
    setPanel(null);
    setNotice("");
    useRankGameStore.setState({ phase: "LOADING", kind });
    try {
      await usePlayerStore.getState().ensurePlayer();
      const playerId = usePlayerStore.getState().playerId ?? localPlayerId();
      if (!playerId) throw new Error("身份未载入，请返回官途重试。");
      const view = await secureFetch<RankedStartView>(
        "/api/games/poetry/rank/start",
        { playerId, kind },
      );
      useRankGameStore.getState().startGame(view);
    } catch (err) {
      useRankGameStore
        .getState()
        .setError(err instanceof Error ? err.message : "出题失败，请重试。");
    }
  };
  const answer = useCallback(async (choice: number | null, timeout = false) => {
    const st = useRankGameStore.getState();
    if (st.phase !== "PLAYING" || !st.gameSessionId || st.submitting) return;
    useRankGameStore.setState({ submitting: true, selectedOption: choice });
    try {
      const judge = await secureFetch<RankedJudgeView>(
        "/api/games/poetry/rank/answer",
        {
          gameSessionId: st.gameSessionId,
          roundIndex: st.currentIndex,
          timeMs: Date.now() - st.roundStartedAt,
          ...(timeout ? { timeout: true } : { choice }),
        },
      );
      useRankGameStore.getState().reveal(choice, judge);
    } catch (err) {
      useRankGameStore
        .getState()
        .setError(
          err instanceof Error ? err.message : "提交失败，请重新连接。",
        );
    }
  }, []);
  useAutoNext({
    active: s.phase === "REVEAL" && panel === null,
    correct: s.lastJudge?.correct ?? null,
    onNext: s.next,
    correctDelay: 1600,
    wrongDelay: 2800,
  });

  const askHint = async () => {
    if (hintBusy || s.hintUsed || s.submitting || s.phase !== "PLAYING") return;
    setHintBusy(true);
    setNotice("");
    const roundIndex = s.currentIndex;
    const sessionId = s.gameSessionId;
    try {
      const result = await secureFetch<{ removedIndexes: number[] }>(
        "/api/games/poetry/rank/hint",
        {
          playerId: usePlayerStore.getState().playerId ?? localPlayerId(),
          gameSessionId: sessionId,
          roundIndex,
        },
      );
      if (useRankGameStore.getState().gameSessionId === sessionId)
        useRankGameStore
          .getState()
          .applyHint({ roundIndex, removedIndexes: result.removedIndexes });
    } catch {
      setNotice("同窗暂未回应，请稍后再试。");
    } finally {
      setHintBusy(false);
    }
  };
  const submitGuess = async (label: string) => {
    if (guessBusy || rank?.guess?.done || guessResult) return;
    setGuessBusy(true);
    setNotice("");
    try {
      const result = await secureFetch<{ correct: boolean; gained: number }>(
        "/api/games/poetry/rank/guess",
        {
          playerId: usePlayerStore.getState().playerId ?? localPlayerId(),
          guessLabel: label,
        },
      );
      setGuessResult(result);
      await loadRank();
    } catch {
      setNotice("竞猜暂未提交，请稍后重试。");
    } finally {
      setGuessBusy(false);
    }
  };
  const goHome = async () => {
    useRankGameStore.getState().reset();
    setPanel(null);
    setNotice("");
    setLoading(true);
    try {
      await loadRank();
      setLoadError("");
    } catch {
      setLoadError("官途暂未载入，请重试。");
    } finally {
      setLoading(false);
    }
  };
  const closePrologue = () => {
    try {
      localStorage.setItem(PROLOGUE_KEY, "1");
    } catch {}
    setPanel(null);
  };
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const todayCell = rank?.daily.cells.find((c) => c?.date === today);
  const dailyDone = todayCell?.state === "done" || todayCell?.state === "made";
  const guessing =
    rank && rank.guess && isGuessAvailable(rank.rankId)
      ? buildGuessOptions(rank.rankId, (rank.rankId + 1) * 7919)
      : null;
  const round = s.rounds[s.currentIndex];
  const active = s.phase === "PLAYING" || s.phase === "REVEAL";

  return (
    <GameShell
      title={active ? KIND_LABEL[s.kind] : BRAND.shortName}
      back="/"
      action={
        s.phase === "IDLE" ? (
          <Link className="quiet-button" href="/play/poetry-rank/leaderboard">
            皇榜 〉
          </Link>
        ) : (
          <span className="muted">
            {s.phase === "FINISHED" ? "已收卷" : `得分 ${s.score}`}
          </span>
        )
      }
    >
      {s.phase === "IDLE" &&
        (loading || loadError || !rank ? (
          <StatusView
            loading="正在续写你的官途…"
            error={loadError}
            onRetry={() => void initialize()}
          />
        ) : (
          <div className="flex-fill rank-home">
            <RankIdentityCard rank={rank} />
            <RankRoad rank={rank} />
            <EventLine event={rank.event} />
            <nav className="aux-nav" aria-label="官途功能">
              <Link href="/play/poetry-rank/ledger">▤ 功名簿</Link>
              <Link href="/play/poetry-rank/gallery">▥ 诗词阁</Link>
              <button onClick={() => setPanel("more")}>··· 更多</button>
            </nav>
            <div className="rank-actions">
              <button
                className="button primary"
                onClick={() => void startGame("PRACTICE")}
              >
                研习诗词
                <small>{rank.rankId === 10 ? "15" : "10"} 题 · 积功名</small>
              </button>
              <button
                className="button gold"
                disabled={!rank.nextUnlocked && rank.rankId !== 10}
                onClick={() => void startGame("EXAM")}
              >
                {rank.rankId === 10 ? "登极大考" : "赴京科考"}
                <small>
                  {rank.rankId === 10
                    ? "15 题 · 再试锋芒"
                    : rank.nextUnlocked
                      ? "功名已足 · 晋升一阶"
                      : "再积功名 · 静候赴考"}
                </small>
              </button>
              <button
                className="button daily-button"
                disabled={dailyDone}
                onClick={() => void startGame("DAILY")}
              >
                {dailyDone ? "✓ 今日诗题已完成" : "每日一诗"}
                <small>
                  {dailyDone ? "明日再会" : "一题一得 · 连满得周奖"}
                </small>
              </button>
            </div>
            <p className="rank-footer">以诗为阶 · 架空成长，非真实官制</p>
          </div>
        ))}
      {(s.phase === "LOADING" || s.phase === "ERROR") && (
        <StatusView
          loading="先生正在为你备卷…"
          error={s.phase === "ERROR" ? s.error : ""}
          onRetry={() => void initialize()}
        >
          {s.phase === "ERROR" && (
            <button className="quiet-button" onClick={() => void goHome()}>
              返回官途
            </button>
          )}
        </StatusView>
      )}
      {active && round && (
        <section className="quiz-screen">
          <div className="quiz-hud">
            <QuizHUD
              index={s.currentIndex}
              total={s.rounds.length}
              combo={s.combo}
              roundStartedAt={s.roundStartedAt}
              durationMs={getRoundTimeMs(round.type)}
              active={s.phase === "PLAYING" && !s.submitting}
              theme="indigo"
              onTimeout={() => void answer(null, true)}
              eventBadge={s.event ? EVENT_BY_ID[s.event]?.name : null}
            />
          </div>
          <div className="quiz-main">
            <div className="question-card">
              <p className="question-label">
                {QUESTION_LABEL[round.type] ?? "请选择正确答案"}
              </p>
              <PagedText key={s.currentIndex} text={round.prompt} />
            </div>
            <div className="quiz-options">
              {round.options.map((opt, i) => {
                const reveal = s.phase === "REVEAL";
                const correct = reveal && s.lastJudge?.correctAnswer === opt;
                const removed =
                  s.hint?.roundIndex === s.currentIndex &&
                  s.hint.removedIndexes.includes(i);
                return (
                  <AdaptiveChoice
                    key={`${s.currentIndex}-${i}`}
                    index={i}
                    text={opt}
                    className={`quiz-choice ${correct ? "correct" : reveal && s.selectedOption === i ? "incorrect" : s.selectedOption === i ? "selected" : ""} ${removed && !reveal ? "removed" : ""}`}
                    disabled={reveal || s.submitting || !!removed}
                    onChoose={() => void answer(i)}
                    onRead={() => {
                      setReadingOption(i);
                      setPanel("option");
                    }}
                    marker={
                      correct
                        ? "✓"
                        : reveal && s.selectedOption === i
                          ? "×"
                          : String.fromCharCode(65 + i)
                    }
                  />
                );
              })}
            </div>
          </div>
          <div className="quiz-bottom">
            {s.phase === "PLAYING" ? (
              <>
                <button
                  className="button secondary"
                  disabled={s.hintUsed || s.submitting || hintBusy}
                  onClick={() => void askHint()}
                >
                  {s.submitting
                    ? "落笔判卷中…"
                    : s.hintUsed
                      ? "本局已问同窗"
                      : hintBusy
                        ? "正在请教…"
                        : "问同窗 · 排除两项 / 功名八折"}
                </button>
              </>
            ) : (
              <>
                <div
                  className={`feedback-label ${s.lastJudge?.correct ? "" : "wrong"}`}
                  role="status"
                >
                  <strong>
                    {s.lastJudge?.correct
                      ? `答对了 · +${s.lastJudge.gained} 功名`
                      : s.lastJudge?.timeout
                        ? "时辰已到 · 看看正解"
                        : "差一点 · 正解已标出"}
                  </strong>
                  <button
                    className="quiet-button"
                    onClick={() => setPanel("feedback")}
                  >
                    读一读解析
                  </button>
                </div>
                <button className="quiz-next" onClick={s.next}>
                  {s.currentIndex + 1 === s.rounds.length
                    ? "查看收获"
                    : "下一题 →"}
                </button>
              </>
            )}
          </div>
          {notice && (
            <p className="error-line" role="status">
              {notice}
            </p>
          )}
        </section>
      )}
      {s.phase === "FINISHED" && s.lastSummary && (
        <>
          <RankSettleView
            summary={s.lastSummary}
            onBack={() => void goHome()}
            onRetry={
              s.lastSummary.kind === "EXAM" &&
              s.lastSummary.promotion.reason === "EXAM_FAILED"
                ? () => void startGame("EXAM")
                : undefined
            }
          />
          <ShareCardView
            summary={s.lastSummary}
            badgeLabels={s.lastSummary.newBadges
              .map((k) => ACHIEVEMENT_BY_KEY.get(k)?.label)
              .filter((x): x is string => !!x)}
          />
        </>
      )}
      {panel === "more" && rank && (
        <Modal title="这一世的行囊" onClose={() => setPanel(null)}>
          <PagedItems>
            {guessing && (
              <button
                className="list-card"
                onClick={() => {
                  setNotice("");
                  setPanel("guess");
                }}
              >
                <span className="list-number">◇</span>
                <div>
                  <strong>猜官衔</strong>
                  <small>
                    {rank.guess?.done
                      ? "今日已猜，明日再来"
                      : "前路迷雾 · 每日一次"}
                  </small>
                </div>
              </button>
            )}
            <button className="list-card" onClick={() => setPanel("record")}>
              <span className="list-number">▤</span>
              <div>
                <strong>最近战绩</strong>
                <small>回看每一步成长</small>
              </div>
            </button>
            {rank.rankId >= 9 && (
              <Link className="list-card" href="/play/poetry-rank/wardrobe">
                <span className="list-number">衣</span>
                <div>
                  <strong>衣冠</strong>
                  <small>换上一身新装</small>
                </div>
              </Link>
            )}
            <button className="list-card" onClick={() => setPanel("prologue")}>
              <span className="list-number">序</span>
              <div>
                <strong>重读序章</strong>
                <small>不忘这一世的起点</small>
              </div>
            </button>
          </PagedItems>
        </Modal>
      )}
      {panel === "record" && rank && (
        <Modal title="最近战绩" onClose={() => setPanel(null)}>
          <PagedItems>
            <p className="paper-card">
              已见 {rank.seenCount} 题 · 共积 {rank.totalExp} 功名
            </p>
            {rank.recentGames.length ? (
              rank.recentGames.map((g, i) => (
                <div key={i} className="list-card">
                  <div>
                    <strong>
                      {KIND_LABEL[g.kind]} · 正确率 {g.accuracy}%
                    </strong>
                    <small>+{g.expGained} 功名</small>
                  </div>
                </div>
              ))
            ) : (
              <p className="paper-card">还未落笔。第一卷，正等你开启。</p>
            )}
          </PagedItems>
        </Modal>
      )}
      {panel === "guess" && rank && guessing && (
        <Modal title="猜猜前路的官衔" onClose={() => setPanel(null)}>
          <p className="muted">再下一阶的迷雾里，会是什么称号？</p>
          <div className="guess-options">
            {guessing.options.map((label) => (
              <button
                className="button secondary"
                key={label}
                disabled={rank.guess?.done || guessBusy || !!guessResult}
                onClick={() => void submitGuess(label)}
              >
                {label}
                {(rank.guess?.done || guessResult) &&
                label === guessing.answerLabel
                  ? " ✓"
                  : ""}
              </button>
            ))}
          </div>
          <p role="status">
            {rank.guess?.done || guessResult
              ? (rank.guess?.correct ?? guessResult?.correct)
                ? "猜中了！功名已入账。"
                : "前路已揭晓，明日再试。"
              : "每日一次，猜中可得 100 功名。"}
          </p>
          {notice && <p className="error-line">{notice}</p>}
        </Modal>
      )}
      {panel === "prologue" && (
        <Modal title="序章 · 重活一世" onClose={closePrologue}>
          <div className="prologue">
            <span className="rebirth-stamp">重 生</span>
            <h2>
              这一次
              <br />
              由我落笔
            </h2>
            <p>
              再睁眼，又是一介布衣。
              <br />
              这一世，我要以诗词改写命运。
            </p>
            <button className="button gold" onClick={closePrologue}>
              开启这一世
            </button>
          </div>
        </Modal>
      )}
      {panel === "option" && round && (
        <Modal
          title={`选项 ${String.fromCharCode(65 + readingOption)} · 全文`}
          onClose={() => setPanel(null)}
        >
          <p className="muted">
            {s.phase === "PLAYING"
              ? "阅读期间仍在计时，确认后再落笔。"
              : "本题已判卷，返回即可查看正解。"}
          </p>
          <PagedText text={round.options[readingOption]} />
          <button
            className="button primary"
            disabled={s.phase !== "PLAYING" || s.submitting}
            onClick={() => {
              setPanel(null);
              void answer(readingOption);
            }}
          >
            选择这一项
          </button>
        </Modal>
      )}
      {panel === "feedback" && s.lastJudge && (
        <Modal title="先生解诗" onClose={() => setPanel(null)}>
          <PagedText
            text={`${s.lastJudge.feedback}\n\n正解：${s.lastJudge.correctAnswer}`}
          />
        </Modal>
      )}
    </GameShell>
  );
}
