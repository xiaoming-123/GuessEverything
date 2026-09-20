/**
 * 诗词升官 · 官阶对局服务（服务端业务编排）
 *
 * 数据与接口闭环（阶段 B，见 docs/design/2026-09-17-poetry-rank-review-and-next.md §阶段B）：
 * - **事务选题**：一个事务内读官阶档案 → 选题 → 占用已见（sourceKey/faceKey）→ 建局；
 *   并发冲突（已见键被另一局先占用，P2002）时换随机种子重新选题，重试耗尽报「稍后再试」。
 * - **持久化已见**：PlayerSeenKey 永久保留（重启不遗忘），官阶模式严格排除已见；
 *   旧学段模式仍走进程内 LRU，互不影响。
 * - **一次性结算**：功名（totalExp）只增不减；结算记账用 settleKey 唯一占位
 *   （status ACTIVE→FINISHED 条件更新，原子），重复结算（重试 / 双开并发）
 *   输掉的一方不加经验、不重复晋升。
 * - **晋升再校验**：结算时复用 evaluatePromotion 纯函数重判（考试目标必须 = 当前官阶 + 1、
 *   功名达标、正确率 ≥60%），客户端不得指定任意级别。
 * - **DB 不可用即停止官阶模式**（503），不做内存兜底——功名与已见必须持久化，
 *   内存兜底会破坏「重启不遗忘」与「一次性记账」红线。
 * - 题量不足如实上报（INSUFFICIENT_CAPACITY / EMPTY_CORPUS），保留进度、等待扩容，
 *   绝不返回不足题数的试卷、绝不自动晋升。
 *
 * 计分口径（与容量报告一致）：逐题用 score.ts 的 computeScore 纯函数
 * （答对基础 100 × 连击倍率 + 速度奖励，答错 0）；
 * 功名按局累加：每局结束时 totalExp += 本局总分（容量审计 expPerPractice/expPerExam 同口径）。
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/crypto/with-crypto";
import { buildRankedRounds, faceKey } from "@/lib/games/poetry/engine";
import { computeScore } from "@/lib/games/poetry/score";
import { evaluatePromotion, PromotionResult } from "@/lib/games/poetry/promote";
import { isRankId, nextRank, RANKS } from "@/lib/games/poetry/rank";
import { judgeClear } from "@/lib/games/stages";
import {
  PoetryQuestionType,
  PoetryRound,
  PoetryRoundView,
  RankKind,
  toRoundView,
} from "@/lib/games/poetry/types";
import { loadPoetryCorpus } from "./poem-repo";
import { isDbAvailable } from "./db-available";
import { prisma } from "./prisma";

/** 官阶对局时限 ms（与学段模式一致：超时会话作废，防作弊） */
const SESSION_TTL_MS = 10 * 60_000;
/** 并发冲突时的事务选题重试上限（换种子重选） */
const MAX_TX_ATTEMPTS = 3;

/* ------------------------------------------------------------------ */
/* 视图（对外下发，剥离 answerIndex 与素材 key）                        */
/* ------------------------------------------------------------------ */

/** 官阶进度视图（路由图 / 功名条数据源） */
export interface RankProgressView {
  rankId: number;
  key: string;
  label: string;
  subtitle: string;
  isEmperor: boolean;
}

export interface RankView {
  rankId: number;
  label: string;
  subtitle: string;
  totalExp: number;
  /** 距下一场科考功名门槛还差多少（已是皇帝恒 0） */
  expToNext: number;
  nextUnlocked: boolean;
  /** 官途表（整条晋升线，供路线图渲染） */
  ranks: RankProgressView[];
}

/** 官阶开局视图 */
export interface RankedStartView {
  gameSessionId: string;
  kind: RankKind;
  rankId: number;
  label: string;
  expiresAt: string;
  /** 当前官阶（开局快照，供前端显示功名条） */
  rank: RankView;
  rounds: PoetryRoundView[];
}

/** 官阶结算摘要（答完最后一题返回） */
export interface RankSummary {
  kind: RankKind;
  rankId: number;
  correctCount: number;
  totalRounds: number;
  accuracy: number;
  stars: number;
  /** 本局授予的功名（= 本局总分；失败局授予低分但功名只增不减） */
  expGained: number;
  totalExp: number;
  promotion: PromotionResult;
  rank: RankView;
}

/* ------------------------------------------------------------------ */
/* 开局                                                                */
/* ------------------------------------------------------------------ */

export interface StartRankedInput {
  /** 玩家 ID（官阶模式必填；缺失时服务端 400 —— 功名 / 已见必须归属玩家持久化） */
  playerId?: string;
  /** PRACTICE 研习 / EXAM 科考（皇帝大考 = EXAM + rankId 10；每日题尚未开放，服务端拒绝） */
  kind: "PRACTICE" | "EXAM";
  /**
   * 官阶 id（0..10）。缺省时服务端按玩家当前官阶推导：
   * - PRACTICE：必须 = 玩家当前官阶（只能研习本官阶窗口）。
   * - EXAM：目标官阶 = 当前官阶 + 1（皇帝大考 = 10），功名须达目标门槛。
   * 客户端显式传入时服务端强制比对，不得越级 / 错位。
   */
  rankId?: number;
}

/**
 * 开局：事务内读档 → 选题 → 占用已见 → 建局；并发冲突换种子重试。
 * 题量不足 / 功名不达标 / 越级开局均如实抛 ApiError（保留进度）。
 */
export async function startRankedSession(
  input: StartRankedInput,
): Promise<RankedStartView> {
  const useDb = await isDbAvailable();
  if (!useDb) {
    // 官阶模式强依赖 DB（功名 / 已见持久化），不可用即停止，不做内存兜底
    throw new ApiError(503, "DB_UNAVAILABLE：官阶模式需要数据库");
  }
  const { playerId, kind } = input;
  if (!playerId || typeof playerId !== "string") {
    throw new ApiError(400, "官阶模式必须提供 playerId");
  }
  if (kind !== "PRACTICE" && kind !== "EXAM") {
    throw new ApiError(400, "未知对局类型");
  }

  // 玩家必须存在（档案在 /api/player 注册）
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { rank: true },
  });
  if (!player) throw new ApiError(404, "玩家不存在");
  const currentRankId = player.rank?.rank ?? 0;

  // 目标官阶：研习 = 当前官阶；科考 = 当前 + 1（越级 / 错位一律拒绝）
  const targetId = kind === "PRACTICE" ? currentRankId : currentRankId + 1;
  if (!isRankId(targetId)) {
    // 已是皇帝：研习 10 窗允许，科考无下一阶
    if (kind === "PRACTICE" && currentRankId === RANKS.length - 1) {
      // 落到下方按 10 处理
    } else {
      throw new ApiError(403, "已是最高官阶，无科考可考");
    }
  }
  const rankId = targetId === RANKS.length ? RANKS.length - 1 : targetId;
  const requested = input.rankId;
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 0 || requested >= RANKS.length) {
      throw new ApiError(400, "未知官阶");
    }
    if (requested !== rankId) {
      throw new ApiError(403, kind === "EXAM"
        ? "科考目标必须是当前官阶的下一阶"
        : "研习只能在当前官阶进行");
    }
  }

  // 功名门槛：研习本官阶无门槛；科考须达目标官阶 expToReach（皇帝 expToReach=0，仅官阶限制）
  const totalExp = player.rank?.totalExp ?? 0;
  if (kind === "EXAM") {
    const required = RANKS[rankId].expToReach;
    if (required > 0 && totalExp < required) {
      throw new ApiError(403, `功名不足（还差 ${required - totalExp}）`);
    }
  }

  const corpus = await loadPoetryCorpus();

  // 事务选题 + 占用已见；并发冲突（P2002）换种子重试
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_TX_ATTEMPTS; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const seen = await tx.playerSeenKey.findMany({
          where: { playerId },
          select: { key: true },
        });
        const excludeKeys = seen.map((s) => s.key);
        // 种子：attempt 0 用当前时间；冲突重试换随机种子重选
        const seed = attempt === 0 ? Date.now() : Math.floor(Math.random() * 2 ** 31);
        const built = buildRankedRounds(corpus, {
          rankId,
          kind,
          seed,
          excludeKeys,
        });
        if (!built.ok) {
          // 题量不足：明确上报（保留进度，等待扩容），不建局
          if (built.reason === "EMPTY_CORPUS") {
            throw new ApiError(404, "本窗口题库为空，等待扩容");
          }
          throw new ApiError(
            409,
            `题库容量不足（本窗口可出 ${built.available}/${built.required} 题），进度已保留，请等待扩容`,
          );
        }
        const rounds = built.rounds;
        const keys = collectSeenKeys(corpus, rounds);
        // 占用已见（幂等 createMany；并发冲突在此抛 P2002 → 换种子重试）
        if (keys.length > 0) {
          await tx.playerSeenKey.createMany({
            data: keys.map((key) => ({ playerId, key })),
          });
        }
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        await tx.gameSession.create({
          data: {
            id,
            mode: "POETRY",
            kind: "RANKED",
            stage: kind,
            rankId,
            rounds: rounds as unknown as object[],
            roundCount: rounds.length,
            status: "ACTIVE",
            score: 0,
            expiresAt,
            playerId,
          },
        });
        return { id, expiresAt, rounds };
      });

      const rankView = await buildRankView(playerId);
      return {
        gameSessionId: result.id,
        kind,
        rankId,
        label: RANKS[rankId].label,
        expiresAt: result.expiresAt.toISOString(),
        rank: rankView,
        rounds: result.rounds.map(toRoundView),
      };
    } catch (err) {
      if (err instanceof ApiError) throw err; // 业务错误（门槛/容量/玩家）直接上抛
      if (isUniqueConflict(err)) {
        lastErr = err;
        continue; // 并发冲突：换种子重新选题
      }
      throw err;
    }
  }
  // 重试耗尽：并发过高
  console.warn("[rank-service] 事务选题重试耗尽", lastErr);
  throw new ApiError(409, "并发开局冲突，请稍后再试");
}

/** 识别 Prisma 唯一约束冲突（P2002） */
function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * 收集一局需占用的已见键：每轮的 sourceKey + 该轮素材的 faceKey。
 * faceKey 一并落库 → 原素材被删除 / 换 ID 后同题面仍被排除（持久化题面身份）。
 */
function collectSeenKeys(
  corpus: { id: string; title: string; poet: string; dynasty: string; grade: number; lines: string[]; famous: boolean }[],
  rounds: PoetryRound[],
): string[] {
  const byKey = new Map<string, { item: (typeof corpus)[number]; lineIndex: number; type: PoetryQuestionType }>();
  for (const item of corpus) {
    for (let i = 0; i < item.lines.length - 1; i++) {
      for (const type of [
        PoetryQuestionType.GUESS_POET,
        PoetryQuestionType.GUESS_TITLE,
        PoetryQuestionType.COMPLETE_NEXT,
      ]) {
        byKey.set(`${item.id}:${i}:${type}`, { item, lineIndex: i, type });
      }
    }
  }
  const keys = new Set<string>();
  for (const r of rounds) {
    keys.add(r.sourceKey);
    const m = byKey.get(r.sourceKey);
    if (m) keys.add(faceKey(m.item, m.lineIndex, m.type));
  }
  return [...keys];
}

/* ------------------------------------------------------------------ */
/* 判题与一次性结算                                                     */
/* ------------------------------------------------------------------ */

export interface RankedJudgeInput {
  gameSessionId: string;
  roundIndex: number;
  /** 客户端提交的选项索引（timeout 时可省略） */
  choice?: number;
  timeMs?: number;
  timeout?: boolean;
}

export interface RankedJudgeView {
  correct: boolean;
  timeout?: boolean;
  correctAnswer: string;
  gained: number;
  multiplier: number;
  totalScore: number;
  finished: boolean;
  summary?: RankSummary;
}

/**
 * 判题（官阶模式）。计分复用 score.ts 纯函数（与容量报告同口径）；
 * 答完最后一题触发一次性结算（功名 + 晋升）。
 */
export async function judgeRankedAnswer(
  input: RankedJudgeInput,
): Promise<RankedJudgeView> {
  const { gameSessionId, roundIndex, timeout = false } = input;
  const choice = input.choice;
  if (
    !gameSessionId ||
    typeof roundIndex !== "number" ||
    (!timeout && typeof choice !== "number")
  ) {
    throw new ApiError(400, "参数不完整");
  }
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：官阶模式需要数据库");

  const session = await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
    include: { answers: { select: { roundIndex: true, correct: true } } },
  });
  if (!session || session.mode !== "POETRY" || session.kind !== "RANKED") {
    throw new ApiError(404, "对局不存在");
  }
  const rounds = session.rounds as unknown as PoetryRound[];
  const rankId = session.rankId ?? 0;
  const kind = (session.stage === "EXAM" ? "EXAM" : "PRACTICE") as RankKind;
  const playerId = session.playerId;

  if (session.status !== "ACTIVE") throw new ApiError(410, "对局已结束");
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.gameSession.update({
      where: { id: gameSessionId },
      data: { status: "EXPIRED" },
    });
    throw new ApiError(410, "对局已超时");
  }
  if (roundIndex < 0 || roundIndex >= rounds.length) {
    throw new ApiError(400, "轮次越界");
  }
  const round = rounds[roundIndex];
  if (!timeout && (!Number.isInteger(choice) || choice! < 0 || choice! >= round.options.length)) {
    throw new ApiError(400, "选项索引越界");
  }
  // 防重复判题
  if (session.answers.some((a) => a.roundIndex === roundIndex)) {
    throw new ApiError(409, "该题已作答");
  }

  // 连击（答错 / 超时清零，中间答错要断）
  let streak = 0;
  for (let i = roundIndex - 1; i >= 0; i--) {
    const a = session.answers.find((x) => x.roundIndex === i);
    if (a?.correct) streak += 1;
    else break;
  }
  const correct = !timeout && choice === round.answerIndex;
  const combo = correct ? streak + 1 : 0;
  const timeMs = Math.max(
    0,
    Math.min(input.timeMs ?? (timeout ? 15_000 : 0), 600_000),
  );
  const score = computeScore({ correct, combo, timeMs });
  const totalScore = session.score + score.gained;
  const finished = roundIndex + 1 >= rounds.length;
  const given = timeout ? "TIMEOUT" : String(choice);

  // 落库答案 + 累计分；最后一题走一次性结算（同一事务，见 settleRankedSession）
  if (!finished || !playerId) {
    await prisma.answerRecord.upsert({
      where: { sessionId_roundIndex: { sessionId: gameSessionId, roundIndex } },
      create: {
        sessionId: gameSessionId,
        roundIndex,
        given,
        correct,
        correctAnswer: round.options[round.answerIndex],
        timeMs,
        gained: score.gained,
      },
      update: { given, correct, correctAnswer: round.options[round.answerIndex], timeMs, gained: score.gained },
    });
    await prisma.gameSession.update({
      where: { id: gameSessionId },
      data: { score: totalScore },
    });
    return {
      correct,
      timeout,
      correctAnswer: round.options[round.answerIndex],
      gained: score.gained,
      multiplier: score.multiplier,
      totalScore,
      finished,
    };
  }

  // 最后一题：一次性结算（答案落库 + 功名 + 晋升，同一事务；settleKey 幂等占位）
  const correctAnswer = round.options[round.answerIndex];
  const summary = await settleRankedSession({
    gameSessionId,
    playerId,
    rankId,
    kind,
    roundIndex,
    given,
    correct,
    correctAnswer,
    timeMs,
    gained: score.gained,
  });
  return {
    correct,
    timeout,
    correctAnswer,
    gained: score.gained,
    multiplier: score.multiplier,
    totalScore,
    finished: true,
    summary,
  };
}

interface SettleInput {
  gameSessionId: string;
  playerId: string;
  rankId: number;
  kind: RankKind;
  /** 最后一题的作答数据（结算事务内落库） */
  roundIndex: number;
  given: string;
  correct: boolean;
  correctAnswer: string;
  timeMs: number;
  /** 最后一题判分（= score.ts computeScore 的 gained） */
  gained: number;
}

/**
 * 一次性结算（单事务）：
 * 1. 原子占位：仅 ACTIVE 且未结算的会话可被结算（status → FINISHED + settleKey），
 *    重复结算 / 并发双开输家在此失败（409）；
 * 2. 最后一题答案落库（含判分，答案写入与结算原子，进程崩溃不产生卡死会话）；
 * 3. 功名 = 结算前功名 + 本局全部判分（从 DB 求和，重启 / 重试可恢复）；
 * 4. 晋升再校验（纯函数：目标官阶 / 功名门槛 / 正确率 ≥60%）。
 */
async function settleRankedSession(input: SettleInput): Promise<RankSummary> {
  const { gameSessionId, playerId } = input;
  const settleKey = `${playerId}:${gameSessionId}:SETTLED`;

  const result = await prisma.$transaction(async (tx) => {
    // 1. 原子占位
    const claimed = await tx.gameSession.updateMany({
      where: { id: gameSessionId, status: "ACTIVE", settleKey: null },
      data: { status: "FINISHED", settleKey },
    });
    if (claimed.count === 0) {
      throw new ApiError(409, "本局已结算，请勿重复提交");
    }

    // 2. 最后一题答案落库（同一事务，崩溃可恢复：结算前重放判题即可重建）
    await tx.answerRecord.upsert({
      where: {
        sessionId_roundIndex: { sessionId: gameSessionId, roundIndex: input.roundIndex },
      },
      create: {
        sessionId: gameSessionId,
        roundIndex: input.roundIndex,
        given: input.given,
        correct: input.correct,
        correctAnswer: input.correctAnswer,
        timeMs: input.timeMs,
        gained: input.gained,
      },
      update: {
        given: input.given,
        correct: input.correct,
        correctAnswer: input.correctAnswer,
        timeMs: input.timeMs,
        gained: input.gained,
      },
    });

    // 3. 本局全部判分（含最后一题，均在库）
    const answers = await tx.answerRecord.findMany({
      where: { sessionId: gameSessionId },
      select: { correct: true, gained: true },
    });
    const correctCount = answers.filter((a) => a.correct).length;
    const totalRounds = answers.length;
    const sessionScore = answers.reduce((s, a) => s + a.gained, 0);
    const accuracy = totalRounds > 0
      ? Math.round((correctCount / totalRounds) * 100)
      : 0;
    const clear = judgeClear(accuracy);

    // 会话总分落库（与结算原子；排行榜只统计学段局，此处仅为数据完整）
    await tx.gameSession.update({
      where: { id: gameSessionId },
      data: { score: sessionScore },
    });

    // 4. 功名记账（单调累加：失败 / 弃局也保留已得功名）
    let rankRow = await tx.playerRank.findUnique({ where: { playerId } });
    if (!rankRow) {
      rankRow = await tx.playerRank.create({
        data: { playerId, rank: 0, totalExp: 0 },
      });
    }
    const currentRank = rankRow.rank;
    const totalExp = rankRow.totalExp + sessionScore;
    await tx.playerRank.update({
      where: { playerId },
      data: { totalExp },
    });

    // 5. 晋升判定（纯函数再校验：目标官阶 / 功名门槛 / 正确率 ≥60%）
    //    研习局 examRank 传 currentRank + 1（KIND_NOT_EXAM 分支短路，值无副作用）
    const promotion = evaluatePromotion({
      currentRank,
      totalExp,
      kind: input.kind,
      examPassed: clear.passed,
      examRank: input.kind === "EXAM" ? input.rankId : currentRank + 1,
    });
    if (promotion.promoted) {
      await tx.playerRank.update({
        where: { playerId },
        data: { rank: promotion.newRank },
      });
    }

    return {
      correctCount,
      totalRounds,
      accuracy,
      stars: clear.stars,
      expGained: sessionScore,
      totalExp,
      promotion,
    };
  });

  const rankView = await buildRankView(playerId);
  return {
    kind: input.kind,
    rankId: input.rankId,
    correctCount: result.correctCount,
    totalRounds: result.totalRounds,
    accuracy: result.accuracy,
    stars: result.stars,
    expGained: result.expGained,
    totalExp: result.totalExp,
    promotion: result.promotion,
    rank: rankView,
  };
}

/* ------------------------------------------------------------------ */
/* 官阶视图                                                            */
/* ------------------------------------------------------------------ */

/** 构建官阶进度视图（功名条 / 路线图数据源） */
async function buildRankView(playerId: string): Promise<RankView> {
  const row = await prisma.playerRank.findUnique({ where: { playerId } });
  const rankId = row?.rank ?? 0;
  const totalExp = row?.totalExp ?? 0;
  const next = nextRank(rankId);
  return {
    rankId,
    label: RANKS[rankId].label,
    subtitle: RANKS[rankId].subtitle,
    totalExp,
    expToNext: next ? Math.max(0, next.expToReach - totalExp) : 0,
    nextUnlocked: next ? totalExp >= next.expToReach : false,
    ranks: RANKS.map((r) => ({
      rankId: r.id,
      key: r.key,
      label: r.label,
      subtitle: r.subtitle,
      isEmperor: !!r.isEmperor,
    })),
  };
}

/** 查官阶视图（/api/games/poetry/rank 的薄壳目标） */
export async function getRankView(playerId: string): Promise<RankView> {
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：官阶模式需要数据库");
  if (!playerId || typeof playerId !== "string") throw new ApiError(400, "参数不完整");
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) throw new ApiError(404, "玩家不存在");
  return buildRankView(playerId);
}
