"use client";

/**
 * 飞花令对局状态（Zustand）
 * 仅持有 UI 状态与服务器返回的脱敏数据，答案永远来自服务端判题。
 */

import { create } from "zustand";
import {
  FeihuaDifficulty,
  FeihuaRoundView,
} from "@/lib/games/feihua/types";
import type {
  FeihuaAnswerView,
  StartFeihuaSessionView,
} from "@/lib/db/feihua-session-service";
import type { SettleSummary } from "@/lib/games/stages";

export type Phase = "IDLE" | "LOADING" | "PLAYING" | "REVEAL" | "FINISHED" | "ERROR";

interface LastJudge {
  correct: boolean;
  /** 是否超时未答 */
  timeout?: boolean;
  correctAnswer: string;
  explanation: string;
  gained: number;
  multiplier: number;
}

interface FeihuaStore {
  phase: Phase;
  error: string;
  difficulty: FeihuaDifficulty;
  gameSessionId: string | null;
  expiresAt: string | null;
  rounds: FeihuaRoundView[];
  currentIndex: number;
  score: number;
  combo: number;
  lastJudge: LastJudge | null;
  selectedOption: number | null;
  /** 判题请求进行中（防点击与超时双发） */
  submitting: boolean;
  /** 本题开始作答的时刻，用于计速度分 */
  roundStartedAt: number;
  /** 最后一题结算摘要（星级/通关/正确率） */
  lastSummary: SettleSummary | null;

  setDifficulty: (difficulty: FeihuaDifficulty) => void;
  reset: () => void;
  setError: (message: string) => void;
  startGame: (view: StartFeihuaSessionView) => void;
  reveal: (choice: number | null, judge: FeihuaAnswerView) => void;
  next: () => void;
}

const initial = {
  phase: "IDLE" as Phase,
  error: "",
  difficulty: FeihuaDifficulty.EASY,
  gameSessionId: null,
  expiresAt: null,
  rounds: [] as FeihuaRoundView[],
  currentIndex: 0,
  score: 0,
  combo: 0,
  lastJudge: null,
  selectedOption: null as number | null,
  submitting: false,
  roundStartedAt: 0,
  lastSummary: null,
};

export const useFeihuaStore = create<FeihuaStore>((set, get) => ({
  ...initial,

  setDifficulty: (difficulty) => set({ difficulty }),
  reset: () => set({ ...initial }),
  setError: (error) => set({ error, phase: "ERROR", submitting: false }),

  startGame: ({ gameSessionId, expiresAt, rounds }) =>
    set({
      ...initial,
      phase: "PLAYING",
      difficulty: get().difficulty,
      gameSessionId,
      expiresAt,
      rounds,
      currentIndex: 0,
      roundStartedAt: Date.now(),
    }),

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
