/**
 * 物品对局会话服务（服务端业务编排）
 *
 * - 开局：调出题引擎生成轮次（含答案），入库，返回剥离答案的视图
 * - 判题：答案只从数据库读取，客户端提交的选择在服务端比对
 * - 计分：调连击计分纯函数，更新会话总分
 */

import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/crypto/with-crypto";
import { buildRounds } from "@/lib/games/object/engine";
import { computeScore } from "@/lib/games/object/score";
import {
  CATEGORY_LABEL,
  ObjectDifficulty,
  ObjectQuestionType,
  ObjectRound,
  ObjectRoundView,
  toRoundView,
} from "@/lib/games/object/types";
import { isDbAvailable } from "./db-available";
import { loadObjectCorpus } from "./object-repo";
import { prisma } from "./prisma";
import {
  memCreate,
  memGet,
  memUpdate,
  memUpsertAnswer,
} from "./memory-session-store";
import { judgeClear, STAGE_ORDER, type SettleSummary } from "@/lib/games/stages";
import { assertStageUnlocked, updateProgress } from "./player-service";
import { getSeenKeys, markSeenKeys } from "./seen-store";
import { getRoundTimeMs } from "@/lib/games/timing";

/** 单局时限 ms（超时会话作废，防作弊） */
const SESSION_TTL_MS = 10 * 60_000;
const MAX_ROUNDS = 20;

export interface StartObjectSessionInput {
  difficulty?: string;
  count?: number;
  /** 玩家 ID（有则做关卡解锁校验并归档进度/排行） */
  playerId?: string;
}

export interface StartObjectSessionView {
  gameSessionId: string;
  difficulty: string;
  expiresAt: string;
  rounds: ObjectRoundView[];
}

export async function startObjectSession(
  input: StartObjectSessionInput,
): Promise<StartObjectSessionView> {
  const difficulty = normalizeDifficulty(input.difficulty);
  const count = Math.min(Math.max(input.count ?? 10, 5), MAX_ROUNDS);

  const useDb = await isDbAvailable();

  // 语料加载与关卡校验互不依赖，并行执行省一个远程往返
  const corpusPromise = loadObjectCorpus();
  // 首关无门禁（按定义已解锁），跳过查询省一次远程往返；非首关强制校验防绕过
  if (input.playerId && useDb && STAGE_ORDER.OBJECT.indexOf(difficulty) > 0) {
    await assertStageUnlocked(input.playerId, "OBJECT", difficulty);
  }
  const corpus = await corpusPromise;
  const rounds = buildRounds(corpus, {
    difficulty,
    count,
    ...(input.playerId ? { excludeKeys: getSeenKeys(input.playerId, "OBJECT") } : {}),
  });
  if (rounds.length === 0) {
    throw new ApiError(500, "题库为空，无法开局");
  }
  if (input.playerId) {
    markSeenKeys(
      input.playerId,
      "OBJECT",
      rounds.map((r) => r.sourceKey),
    );
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // DB 优先，不可用时内存兜底（本地零配置跑通闭环）
  if (useDb) {
    const session = await prisma.gameSession.create({
      data: {
        id: randomUUID(),
        mode: "OBJECT",
        stage: difficulty,
        rounds: rounds as unknown as object[],
        roundCount: rounds.length,
        status: "ACTIVE",
        score: 0,
        expiresAt,
        ...(input.playerId ? { playerId: input.playerId } : {}),
      },
    });
    return toStartView(session.id, difficulty, expiresAt, rounds);
  }

  const memId = `mem-${randomUUID()}`;
  memCreate({
    id: memId,
    mode: "OBJECT",
    stage: difficulty,
    rounds,
    roundCount: rounds.length,
    status: "ACTIVE",
    score: 0,
    expiresAt,
    answers: new Map(),
  });
  return toStartView(memId, difficulty, expiresAt, rounds);
}

function toStartView(
  gameSessionId: string,
  difficulty: ObjectDifficulty,
  expiresAt: Date,
  rounds: ObjectRound[],
): StartObjectSessionView {
  return {
    gameSessionId,
    difficulty,
    expiresAt: expiresAt.toISOString(),
    rounds: rounds.map(toRoundView),
  };
}

export interface ObjectAnswerInput {
  gameSessionId?: string;
  roundIndex?: number;
  /** 客户端提交的选项索引（timeout 时可省略） */
  choice?: number;
  timeMs?: number;
  /** 每题倒计时耗尽（按答错处理） */
  timeout?: boolean;
  /** 线索题已揭示的线索条数（含首条，≥1；每条额外线索 -30） */
  revealedClues?: number;
}

export interface ObjectAnswerView {
  correct: boolean;
  /** 是否超时未答（按答错处理） */
  timeout?: boolean;
  correctAnswer: string;
  explanation: string;
  gained: number;
  multiplier: number;
  totalScore: number;
  finished: boolean;
  /** 答完最后一题时的结算摘要（星级/通关/正确率） */
  summary?: SettleSummary;
}

export async function judgeObjectAnswer(
  input: ObjectAnswerInput,
): Promise<ObjectAnswerView> {
  const { gameSessionId, roundIndex, timeout = false } = input;
  const choice = input.choice;
  if (
    !gameSessionId ||
    typeof roundIndex !== "number" ||
    (!timeout && typeof choice !== "number")
  ) {
    throw new ApiError(400, "参数不完整");
  }

  // 统一会话视图：DB 与内存兜底同构
  const useDb = gameSessionId.startsWith("mem-") ? false : await isDbAvailable();
  let rounds: ObjectRound[];
  let status: string;
  let expiresAt: Date;
  let currentScore: number;
  let sessionStage: string;
  let sessionPlayerId: string | null = null;
  let priorAnswers: { roundIndex: number; correct: boolean }[];

  if (useDb) {
    // 会话行与历史作答互不依赖，并行查询（省一个远程往返）
    const [session, records] = await Promise.all([
      prisma.gameSession.findUnique({ where: { id: gameSessionId } }),
      prisma.answerRecord.findMany({
        where: { sessionId: gameSessionId },
        select: { roundIndex: true, correct: true },
      }),
    ]);
    if (!session || session.mode !== "OBJECT") throw new ApiError(404, "对局不存在");
    rounds = session.rounds as unknown as ObjectRound[];
    status = session.status;
    expiresAt = session.expiresAt;
    currentScore = session.score;
    sessionStage = session.stage;
    sessionPlayerId = session.playerId;
    priorAnswers = records;
  } else {
    const mem = memGet(gameSessionId);
    if (!mem || mem.mode !== "OBJECT") throw new ApiError(404, "对局不存在");
    rounds = mem.rounds as ObjectRound[];
    status = mem.status;
    expiresAt = mem.expiresAt;
    currentScore = mem.score;
    sessionStage = mem.stage;
    priorAnswers = [...mem.answers.entries()].map(([ri, a]) => ({
      roundIndex: ri,
      correct: a.correct,
    }));
  }

  if (status !== "ACTIVE") throw new ApiError(410, "对局已结束");
  if (expiresAt.getTime() < Date.now()) {
    if (useDb) {
      await prisma.gameSession.update({
        where: { id: gameSessionId },
        data: { status: "EXPIRED" },
      });
    } else {
      memUpdate(gameSessionId, { status: "EXPIRED" });
    }
    throw new ApiError(410, "对局已超时");
  }
  if (roundIndex < 0 || roundIndex >= rounds.length) {
    throw new ApiError(400, "轮次越界");
  }

  const round = rounds[roundIndex];
  // 选项索引必须落在有效范围内（超时提交无需选项）
  if (!timeout && (!Number.isInteger(choice) || choice! < 0 || choice! >= round.options.length)) {
    throw new ApiError(400, "选项索引越界");
  }

  // 历史作答：防重复判题 + 计算真实连击
  if (priorAnswers.some((a) => a.roundIndex === roundIndex)) {
    throw new ApiError(409, "该题已作答");
  }
  let streak = 0;
  for (let i = roundIndex - 1; i >= 0; i--) {
    const a = priorAnswers.find((x) => x.roundIndex === i);
    if (a?.correct) streak += 1;
    else break;
  }

  const correct = !timeout && choice === round.answerIndex;
  const correctAnswer = round.options[round.answerIndex];
  const categoryLabel = CATEGORY_LABEL[round.meta.category];
  const lastClue = round.meta.clues[round.meta.clues.length - 1];

  const explanation =
    round.type === ObjectQuestionType.GUESS_CATEGORY
      ? `「${round.meta.name}」属于${categoryLabel}，${lastClue}`
      : round.type === ObjectQuestionType.GUESS_FROM_RIDDLE
        ? `谜底就是「${correctAnswer}」（${categoryLabel}），${lastClue}`
        : `「${correctAnswer}」是一种${categoryLabel}，${lastClue}`;

  // 连击数：答对则在当前连对 streak 上 +1，答错/超时清零
  const combo = correct ? streak + 1 : 0;
  // 超时但客户端没带耗时：按该题型时限兜底（谜语 20s，其余 15s）
  const fallbackTime = timeout ? getRoundTimeMs(round.type) : 0;
  const timeMs = Math.max(0, Math.min(input.timeMs ?? fallbackTime, 600_000));
  // 线索揭示数仅对线索题生效，并夹在 [1, 实际线索数] 防篡改
  const revealedClues =
    round.type === ObjectQuestionType.GUESS_FROM_CLUES
      ? Math.max(1, Math.min(input.revealedClues ?? 1, round.clues.length))
      : 1;
  const score = computeScore({ correct, combo, timeMs, revealedClues });

  const totalScore = currentScore + score.gained;
  const finished = roundIndex + 1 >= rounds.length;

  const given = timeout ? "TIMEOUT" : String(choice);

  if (useDb) {
    // 两个写入互不依赖，并行执行
    await Promise.all([
      prisma.answerRecord.upsert({
        where: { sessionId_roundIndex: { sessionId: gameSessionId, roundIndex } },
        create: {
          sessionId: gameSessionId,
          roundIndex,
          given,
          correct,
          correctAnswer,
          timeMs,
        },
        update: { given, correct, correctAnswer, timeMs },
      }),
      prisma.gameSession.update({
        where: { id: gameSessionId },
        data: {
          score: totalScore,
          ...(finished ? { status: "FINISHED" } : {}),
        },
      }),
    ]);
  } else {
    memUpsertAnswer({
      sessionId: gameSessionId,
      roundIndex,
      given,
      correct,
      correctAnswer,
      timeMs,
    });
    memUpdate(gameSessionId, {
      score: totalScore,
      ...(finished ? { status: "FINISHED" } : {}),
    });
  }

  // 结算：统计正确率 → 星级/通关判定 → 归档进度
  let summary: SettleSummary | undefined;
  if (finished) {
    // 历史作答已在本轮判题时取回，直接累加，无需再查一次
    const correctCount =
      priorAnswers.filter((a) => a.correct).length + (correct ? 1 : 0);
    const accuracy = Math.round((correctCount / rounds.length) * 100);
    const clear = judgeClear(accuracy);
    summary = {
      correctCount,
      totalRounds: rounds.length,
      accuracy,
      stars: clear.stars,
      passed: clear.passed,
      clearedNow: false,
    };
    if (sessionPlayerId && useDb) {
      // 进度读取与进度归档互不依赖，并行执行
      const [prev] = await Promise.all([
        prisma.playerProgress.findUnique({
          where: {
            playerId_mode_stage: { playerId: sessionPlayerId, mode: "OBJECT", stage: sessionStage },
          },
          select: { stars: true },
        }),
        updateProgress({
          playerId: sessionPlayerId,
          mode: "OBJECT",
          stage: sessionStage,
          score: totalScore,
          accuracyPercent: accuracy,
          stars: clear.stars,
          passed: clear.passed,
        }),
      ]);
      summary.clearedNow = clear.stars > (prev?.stars ?? 0);
    }
  }

  return {
    correct,
    timeout,
    correctAnswer,
    explanation,
    gained: score.gained,
    multiplier: score.multiplier,
    totalScore,
    finished,
    summary,
  };
}

function normalizeDifficulty(raw?: string): ObjectDifficulty {
  const value = raw?.toUpperCase();
  if (value === ObjectDifficulty.NORMAL || value === ObjectDifficulty.HARD) {
    return value as ObjectDifficulty;
  }
  return ObjectDifficulty.EASY;
}
