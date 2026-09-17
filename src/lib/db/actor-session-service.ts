/**
 * 演员对局会话服务（服务端业务编排）
 *
 * - 开局：调出题引擎生成轮次（含答案），入库，返回剥离答案的视图
 * - 判题：答案只从数据库读取，客户端提交的选择在服务端比对
 * - 计分：调连击计分纯函数，更新会话总分
 */

import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/crypto/with-crypto";
import { buildRounds } from "@/lib/games/actor/engine";
import { computeScore } from "@/lib/games/actor/score";
import {
  ActorDifficulty,
  ActorQuestionType,
  ActorRound,
  ActorRoundView,
  REGION_LABEL,
  toRoundView,
} from "@/lib/games/actor/types";
import { loadActorCorpus } from "./actor-repo";
import { isDbAvailable } from "./db-available";
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

/** 单局时限 ms（超时会话作废，防作弊） */
const SESSION_TTL_MS = 10 * 60_000;
const MAX_ROUNDS = 20;

export interface StartActorSessionInput {
  difficulty?: string;
  count?: number;
  /** 玩家 ID（有则做关卡解锁校验并归档进度/排行） */
  playerId?: string;
}

export interface StartActorSessionView {
  gameSessionId: string;
  difficulty: string;
  expiresAt: string;
  rounds: ActorRoundView[];
}

export async function startActorSession(
  input: StartActorSessionInput,
): Promise<StartActorSessionView> {
  const difficulty = normalizeDifficulty(input.difficulty);
  const count = Math.min(Math.max(input.count ?? 10, 5), MAX_ROUNDS);

  const useDb = await isDbAvailable();

  // 语料加载与关卡校验互不依赖，并行执行省一个远程往返
  const corpusPromise = loadActorCorpus();
  // 首关无门禁（按定义已解锁），跳过查询省一次远程往返；非首关强制校验防绕过
  if (input.playerId && useDb && STAGE_ORDER.ACTOR.indexOf(difficulty) > 0) {
    await assertStageUnlocked(input.playerId, "ACTOR", difficulty);
  }
  const corpus = await corpusPromise;
  const rounds = buildRounds(corpus, {
    difficulty,
    count,
    ...(input.playerId ? { excludeKeys: getSeenKeys(input.playerId, "ACTOR") } : {}),
  });
  if (rounds.length === 0) {
    throw new ApiError(500, "题库为空，无法开局");
  }
  if (input.playerId) {
    markSeenKeys(
      input.playerId,
      "ACTOR",
      rounds.map((r) => r.sourceKey),
    );
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // DB 优先，不可用时内存兜底（本地零配置跑通闭环）
  if (useDb) {
    const session = await prisma.gameSession.create({
      data: {
        id: randomUUID(),
        mode: "ACTOR",
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
    mode: "ACTOR",
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
  difficulty: ActorDifficulty,
  expiresAt: Date,
  rounds: ActorRound[],
): StartActorSessionView {
  return {
    gameSessionId,
    difficulty,
    expiresAt: expiresAt.toISOString(),
    rounds: rounds.map(toRoundView),
  };
}

export interface ActorAnswerInput {
  gameSessionId?: string;
  roundIndex?: number;
  /** 客户端提交的选项索引（timeout 时可省略） */
  choice?: number;
  timeMs?: number;
  /** 每题倒计时耗尽（按答错处理） */
  timeout?: boolean;
}

export interface ActorAnswerView {
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

export async function judgeActorAnswer(
  input: ActorAnswerInput,
): Promise<ActorAnswerView> {
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
  let rounds: ActorRound[];
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
    if (!session || session.mode !== "ACTOR") throw new ApiError(404, "对局不存在");
    rounds = session.rounds as unknown as ActorRound[];
    status = session.status;
    expiresAt = session.expiresAt;
    currentScore = session.score;
    sessionStage = session.stage;
    sessionPlayerId = session.playerId;
    priorAnswers = records;
  } else {
    const mem = memGet(gameSessionId);
    if (!mem || mem.mode !== "ACTOR") throw new ApiError(404, "对局不存在");
    rounds = mem.rounds as ActorRound[];
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

  const regionLabel = REGION_LABEL[round.meta.region];
  const explanation =
    round.type === ActorQuestionType.GUESS_WORK
      ? `《${correctAnswer}》中，${round.meta.actorName} 饰演「${round.meta.role}」（${regionLabel}）`
      : `「${correctAnswer}」（${regionLabel}）的代表作有《${round.meta.works
          .slice(0, 2)
          .join("》《")}》，经典角色包括${round.meta.roles
          .slice(0, 2)
          .map((r) => `「${r}」`)
          .join("、")}`;

  // 连击数：答对则在当前连对 streak 上 +1，答错/超时清零
  const combo = correct ? streak + 1 : 0;
  const timeMs = Math.max(
    0,
    Math.min(input.timeMs ?? (timeout ? 15_000 : 0), 600_000),
  );
  const score = computeScore({ correct, combo, timeMs });

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
            playerId_mode_stage: { playerId: sessionPlayerId, mode: "ACTOR", stage: sessionStage },
          },
          select: { stars: true },
        }),
        updateProgress({
          playerId: sessionPlayerId,
          mode: "ACTOR",
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

function normalizeDifficulty(raw?: string): ActorDifficulty {
  const value = raw?.toUpperCase();
  if (value === ActorDifficulty.NORMAL || value === ActorDifficulty.HARD) {
    return value as ActorDifficulty;
  }
  return ActorDifficulty.EASY;
}
