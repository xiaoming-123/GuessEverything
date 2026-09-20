"use client";

/**
 * 诗词升官 · 官途对局状态（Zustand）
 *
 * 仅持有 UI 状态与服务器返回的脱敏数据（答案永不下发）；
 * 功名 / 官阶权威数据来自服务端结算摘要（RankSummary），
 * 页面在结算后刷新玩家档案同步。
 */

import { create } from "zustand";
import type { PoetryRoundView, RankKind } from "@/lib/games/poetry/types";
import type { PersonaKey } from "@/lib/games/poetry/persona";
import type {
  RankedJudgeView,
  RankedResumeView,
  RankedStartView,
  RankSummary,
  RankView,
} from "@/lib/db/rank-service";

export type RankPhase =
  | "IDLE"
  | "LOADING"
  | "PLAYING"
  | "REVEAL"
  | "FINISHED"
  | "ERROR";

interface LastJudge {
  correct: boolean;
  timeout?: boolean;
  correctAnswer: string;
  explanation: string;
  /** 人设反馈句（D1：服务端拼装） */
  feedback: string;
  gained: number;
  multiplier: number;
}

interface RankGameStore {
  phase: RankPhase;
  error: string;
  gameSessionId: string | null;
  expiresAt: string | null;
  kind: RankKind;
  rankId: number;
  /** 开局时的官阶快照（功名条展示） */
  rank: RankView | null;
  rounds: PoetryRoundView[];
  currentIndex: number;
  score: number;
  combo: number;
  lastJudge: LastJudge | null;
  selectedOption: number | null;
  submitting: boolean;
  roundStartedAt: number;
  /** 最后一题结算摘要（功名 / 晋升） */
  lastSummary: RankSummary | null;
  /** 本局人设（D1：start/resume 下发，气泡署名） */
  persona: PersonaKey | null;
  /** 开局白（D1：服务端按会话 id 哈希生成，同会话同句） */
  opening: string;

  reset: () => void;
  setError: (message: string) => void;
  startGame: (view: RankedStartView) => void;
  /** 刷新恢复：进入一局已进行中的官阶局（从首个未答轮次继续） */
  resume: (view: RankedResumeView, rank: RankView | null) => void;
  reveal: (choice: number | null, judge: RankedJudgeView) => void;
  next: () => void;
}

const initial = {
  phase: "IDLE" as RankPhase,
  error: "",
  gameSessionId: null,
  expiresAt: null,
  kind: "PRACTICE" as RankKind,
  rankId: 0,
  rank: null,
  rounds: [],
  currentIndex: 0,
  score: 0,
  combo: 0,
  lastJudge: null,
  selectedOption: null as number | null,
  submitting: false,
  roundStartedAt: 0,
  lastSummary: null,
  persona: null as PersonaKey | null,
  opening: "",
};

export const useRankGameStore = create<RankGameStore>((set, get) => ({
  ...initial,

  reset: () => set({ ...initial }),
  setError: (error) => set({ error, phase: "ERROR", submitting: false }),

  startGame: ({ gameSessionId, expiresAt, kind, rankId, rank, rounds, persona, opening }) =>
    set({
      ...initial,
      phase: "PLAYING",
      gameSessionId,
      expiresAt,
      kind,
      rankId,
      rank,
      rounds,
      currentIndex: 0,
      roundStartedAt: Date.now(),
      persona,
      opening,
    }),

  resume: (view, rank) => {
    const answered = new Set(view.answeredIndexes);
    let index = 0;
    while (index < view.rounds.length && answered.has(index)) index += 1;
    set({
      ...initial,
      phase: "PLAYING",
      gameSessionId: view.gameSessionId,
      expiresAt: view.expiresAt,
      kind: view.kind,
      rankId: view.rankId,
      rank,
      rounds: view.rounds,
      score: view.score,
      currentIndex: index,
      roundStartedAt: Date.now(),
      persona: view.persona,
      opening: view.opening,
    });
  },

  reveal: (selectedOption, judge) =>
    set({
      phase: "REVEAL",
      selectedOption,
      submitting: false,
      score: judge.totalScore,
      combo: judge.correct ? get().combo + 1 : 0,
      lastSummary: judge.summary ?? get().lastSummary,
      lastJudge: {
        correct: judge.correct,
        timeout: judge.timeout,
        correctAnswer: judge.correctAnswer,
        explanation: judge.explanation,
        feedback: judge.feedback,
        gained: judge.gained,
        multiplier: judge.multiplier,
      },
    }),

  next: () => {
    const { currentIndex, rounds } = get();
    if (currentIndex + 1 >= rounds.length) {
      set({ phase: "FINISHED" });
      return;
    }
    set({
      phase: "PLAYING",
      currentIndex: currentIndex + 1,
      selectedOption: null,
      lastJudge: null,
      roundStartedAt: Date.now(),
    });
  },
}));
