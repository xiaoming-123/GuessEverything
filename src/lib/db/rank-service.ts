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
import { buildRankedRounds, roundFaceKey } from "@/lib/games/poetry/engine";
import { computeScore } from "@/lib/games/poetry/score";
import { evaluatePromotion, PromotionResult } from "@/lib/games/poetry/promote";
import {
  feedbackLine,
  eventLine,
  failLine,
  openingLine,
  personaFor,
  practiceLine,
  promotionLine,
  type PersonaKey,
} from "@/lib/games/poetry/persona";
import {
  activeEvent,
  eventForDate,
  type ActiveEventView,
} from "@/lib/games/poetry/events";
import { isRankId, nextRank, RANKS } from "@/lib/games/poetry/rank";
import { judgeClear } from "@/lib/games/stages";
import {
  evaluateAchievements,
  type AchievementCtx,
} from "@/lib/games/poetry/achievements";
import {
  buildMonthCells,
  completedWeeks,
  completedWeeksThisMonth,
  MONTHLY_MAKEUP_QUOTA,
  WEEKLY_BONUS_PER_WEEK,
  type DailyView,
} from "@/lib/games/poetry/weekly";
import {
  GUESS_REWARD,
  guessTargetRank,
  isGuessAvailable,
  mulberry32,
  pickHintRemoved,
} from "@/lib/games/poetry/guess";
import {
  canEquipSkin,
  skinsUnlockedByBadges,
} from "@/lib/games/poetry/skins";
import { seasonKeyForDate } from "@/lib/games/poetry/season";
import {
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

/**
 * 服务端本地日历日（Asia/Shanghai，YYYY-MM-DD）。
 * 每日题口径（详设 §2.1）：Date.now() + Intl.DateTimeFormat 取本地日。
 */
function localDate(now: Date = new Date()): string {
  // en-CA 输出 ISO 风格 YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * 会话 stage → RankKind（单点推导，review A7）。
 * 此前 start/judge/resume 三处各写 `stage === "EXAM" ? "EXAM" : "PRACTICE"`
 * 三元，DAILY 会静默降级成 PRACTICE（结算摘要 kind / persona 映射全错）。
 */
export function kindOfStage(stage: string): RankKind {
  if (stage === "EXAM") return "EXAM";
  if (stage === "DAILY") return "DAILY";
  return "PRACTICE";
}

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

/**
 * 会话 id → 无符号 32 位哈希（开局白 seed 用；确定性，同会话同白）。
 * FNV-1a 32 位口径，纯字符串运算。
 */
function hashIdToSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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
  /**
   * 已见题累计（D1，详设 §2.3 口径）：PlayerSeenKey 同时存 sourceKey 行
   * （`poemId:lineIndex:type`，冒号分隔）与 faceKey 行（`type|prompt|correct`，
   * 竖线分隔）——直接 count() ≈ 2× 真实题数；只数 sourceKey 行
   * （faceKey 首段是题型枚举名，不含冒号）。
   */
  seenCount: number;
  /** 近 3 局战绩（最新在前；功名估算 avgExp 与「最近战绩」行共用，D1 交付） */
  recentGames: Array<{ kind: RankKind; expGained: number; accuracy: number }>;
  /** 已获成就 key 集（D2，详设 §2.3；文案客户端查纯逻辑表 ACHIEVEMENTS 渲染） */
  badges: string[];
  /** 每日题月历（D2，详设 §2.1） */
  daily: DailyView;
  /** 语料总数（D3 诗词阁分母；D2 先行接入 `Poem.count()` 口径） */
  corpusTotal: number;
  /** 剪影竞猜（D4 详设 §4.2）：rankId>=8 时 null（入口整体隐藏） */
  guess: { done: boolean; correct?: boolean; gained?: number } | null;
  /** 限时事件（P2 详设 §2.1）：当前生效事件（无则 null；横幅数据源） */
  event: ActiveEventView | null;
  /** 皮肤（P3-1 详设 §1.4）：已拥有 key 集 + 当前穿戴（文案客户端查 SKINS 表渲染） */
  skins: { owned: string[]; equipped: string | null };
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
  /** 本局人设（D1，详设 §1.2：研习=引路先生 / 科考=主考官 / 登极=钦差） */
  persona: PersonaKey;
  /** 开局白（服务端按会话 id 哈希生成，同会话同句） */
  opening: string;
  /** 开局锁定的限时事件（P2 详设 §2.2）：null 表示未命中；HUD 徽标数据源 */
  event: string | null;
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
  /** 结算台词（D1：擢升 / 失败 / 研习三分支，persona 纯函数拼装） */
  settleLine: string;
  /** 本次新达成成就 key（D2；文案客户端查纯逻辑表 ACHIEVEMENTS 渲染） */
  newBadges: string[];
  /** 本局用过问同窗（D4 详设 §4.1：功名已 ×0.8 折价，结算展示提示） */
  hintUsed: boolean;
  /** 本局实际套用的限时事件（P2 详设 §2.2；EXAM 功名入账不加成但保留信息） */
  event: { id: string; name: string; expMultiplier: number } | null;
}

/* ------------------------------------------------------------------ */
/* 开局                                                                */
/* ------------------------------------------------------------------ */

export interface StartRankedInput {
  /** 玩家 ID（官阶模式必填；缺失时服务端 400 —— 功名 / 已见必须归属玩家持久化） */
  playerId?: string;
  /** PRACTICE 研习 / EXAM 科考（皇帝大考 = EXAM + rankId 10）/ DAILY 每日题 */
  kind: "PRACTICE" | "EXAM" | "DAILY";
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
  if (kind !== "PRACTICE" && kind !== "EXAM" && kind !== "DAILY") {
    throw new ApiError(400, "未知对局类型");
  }

  // 玩家必须存在（档案在 /api/player 注册）
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { rank: true },
  });
  if (!player) throw new ApiError(404, "玩家不存在");
  const currentRankId = player.rank?.rank ?? 0;

  // 目标官阶（review A7 单点化）：研习/每日 = 当前官阶（本官阶研习窗口，
  // DAILY 不越级）；科考 = 当前 + 1（越级 / 错位一律拒绝）
  const targetId = kind === "EXAM" ? currentRankId + 1 : currentRankId;
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

  // 每日题：一玩家一日一局（幂等；详设 §2.1 服务端时序）
  // settled → 409；未结算且会话有效 → 409（客户端转 resume 续答）；
  // 会话 EXPIRED / 不存在（review A2 死锁修复）→ 事务内占位换新 sessionId 重建，
  // 旧会话作废不结算（功名不入账，与 PRACTICE 弃局同口径），当日机会不卡死。
  let dailyDate: string | null = null;
  if (kind === "DAILY") {
    dailyDate = localDate();
    const daily = await prisma.playerDaily.findUnique({
      where: { playerId_date: { playerId, date: dailyDate } },
    });
    if (daily) {
      if (daily.settled) throw new ApiError(409, "今日已答完每日题");
      const sess = await prisma.gameSession.findUnique({ where: { id: daily.sessionId } });
      if (sess && sess.status === "ACTIVE" && sess.expiresAt.getTime() > Date.now()) {
        throw new ApiError(409, "今日每日题尚未结算，请继续作答");
      }
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
        const keys = collectSeenKeys(rounds);
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
        // 每日题占位（先占位后选题的「占位」步：upsert 同时覆盖
        // ① 当日首开 create ② 过期重建时换新 sessionId——P2002 由外层重试兜底）
        if (dailyDate) {
          await tx.playerDaily.upsert({
            where: { playerId_date: { playerId, date: dailyDate } },
            create: { playerId, date: dailyDate, sessionId: id, settled: false, madeUp: false },
            update: { sessionId: id, settled: false },
          });
        }
        return { id, expiresAt, rounds };
      });

      const rankView = await buildRankView(playerId);
      const persona = personaFor(kind, rankId);
      return {
        gameSessionId: result.id,
        kind,
        rankId,
        label: RANKS[rankId].label,
        expiresAt: result.expiresAt.toISOString(),
        rank: rankView,
        rounds: result.rounds.map(toRoundView),
        persona,
        opening: openingLine(persona, hashIdToSeed(result.id)),
        // 限时事件（P2 详设 §2.2）：开局锁定（HUD 徽标）
        event: activeEvent(Date.now())?.id ?? null,
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
 * 收集一局需占用的已见键：每轮的 sourceKey + 该轮的 faceKey。
 * faceKey 一并落库 → 原素材被删除 / 换 ID 后同题面仍被排除（持久化题面身份）。
 *
 * review A4-2（D3）：不再反查语料 byKey 映射——faceKey 直接由 round 重构
 * （roundFaceKey，round.prompt/options/answerIndex/meta.pos 与 faceKey 同口径，
 * 同一代码路径生成）。这消除了「素材枚举必须与 faceKeyOfKey 口径一致」的
 * 隐式耦合，且新题型（FILL_CHAR/DYNASTY_PICK 四段/新格式）的已见排除天然生效。
 */
function collectSeenKeys(
  rounds: PoetryRound[],
): string[] {
  const keys = new Set<string>();
  for (const r of rounds) {
    keys.add(r.sourceKey);
    keys.add(roundFaceKey(r));
  }
  return [...keys];
}

/* ------------------------------------------------------------------ */
/* 判题与一次性结算                                                     */
/* ------------------------------------------------------------------ */

/**
 * 诗词阁落库（D3 详设 §3.1，幂等）：答过即入库（不论对错），按 poemId 去重。
 * - poemId = sourceKey 第一段（sourceKey = poemId:lineIndex:type[:pos]，engine.ts 既有格式）；
 * - title/poet/dynasty/grade 由 round.meta 还原（服务端专用字段）；
 * - mastered 仅当本题 correct 且该诗未 mastered 时置 true（条件更新）。
 * 判题非末题分支与结算事务内都调用（upsert 幂等，重复调用无副作用）。
 */
async function recordGallery(
  tx: {
    playerPoem: {
      upsert(args: Parameters<typeof prisma.playerPoem.upsert>[0]): Promise<unknown>;
      updateMany(args: Parameters<typeof prisma.playerPoem.updateMany>[0]): Promise<unknown>;
    };
  },
  playerId: string,
  round: PoetryRound,
  correct: boolean,
): Promise<void> {
  const poemId = round.sourceKey.split(":")[0];
  if (!poemId) return;
  const { poemTitle, poet, dynasty, grade } = round.meta;
  await tx.playerPoem.upsert({
    where: { playerId_poemId: { playerId, poemId } },
    create: {
      playerId,
      poemId,
      title: poemTitle,
      poet,
      dynasty,
      grade,
      mastered: correct,
    },
    update: {},
  });
  if (correct) {
    await tx.playerPoem.updateMany({
      where: { playerId, poemId, mastered: false },
      data: { mastered: true },
    });
  }
}

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
  /** 判题解释（出自哪首，服务端生成；客户端无 meta） */
  explanation: string;
  /** 人设反馈句（D1：服务端拼，不含答案本身，详设 §1.2） */
  feedback: string;
  gained: number;
  multiplier: number;
  totalScore: number;
  finished: boolean;
  summary?: RankSummary;
}

/**
 * 判题解释（官阶模式）。服务端持有 meta（客户端视图已剥离），
 * 拼「出自《诗题》·朝代·作者」；客户端据此展示出处。
 */
function buildExplanation(round: PoetryRound): string {
  const { poemTitle, poet, dynasty } = round.meta;
  return `出自《${poemTitle}》 · ${dynasty} · ${poet}`;
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
    // roundIndex 必选 + 升序（review B5：maxCombo 推导按升序扫最大连续 correct 段）
    include: { answers: { select: { roundIndex: true, correct: true, gained: true }, orderBy: { roundIndex: "asc" } } },
  });
  if (!session || session.mode !== "POETRY" || session.kind !== "RANKED") {
    throw new ApiError(404, "对局不存在");
  }
  const rounds = session.rounds as unknown as PoetryRound[];
  const rankId = session.rankId ?? 0;
  const kind = kindOfStage(session.stage);
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
  const explanation = buildExplanation(round);
  // 人设反馈（服务端拼；combo = 结算前 streak + 1，详设 §1.2）
  const personaKey = personaFor(kind, rankId);
  const feedback = feedbackLine(personaKey, {
    correct,
    timeout,
    combo,
    explanation,
  });

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
    // 诗词阁落库（D3：非末题每题即入阁；幂等 upsert）
    if (playerId) await recordGallery(prisma, playerId, round, correct);
    return {
      correct,
      timeout,
      correctAnswer: round.options[round.answerIndex],
      explanation,
      feedback,
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
    createdAt: session.createdAt,
  });
  return {
    correct,
    timeout,
    correctAnswer,
    explanation,
    feedback,
    gained: score.gained,
    multiplier: score.multiplier,
    totalScore,
    finished: true,
    summary,
  };
}

/** 问同窗（D4 详设 §4.1）：一局一次，移除 2 个错误选项（不泄答案）。
 *  原子抢占（hintUsed false→true 条件更新）；roundIndex 校验「当前未答轮次」。 */
export interface HintInput {
  playerId?: string;
  gameSessionId?: string;
  roundIndex?: number;
}

export interface HintView {
  removedIndexes: number[];
}

/**
 * 问同窗（D4 详设 §4.1）：
 * - 一局一次：hintUsed false→true 条件更新原子抢占（并发双请求仅 1 成功，输家 409）；
 * - 不泄答案：removedIndexes 全部 ≠ answerIndex（纯函数 pickHintRemoved 保证）；
 * - 仅当前未答轮次有效：roundIndex 必须未答（已答 400 / 越界 400）；
 * - 对局无效 404 / 已结束 410 / 已用过 409。
 */
export async function requestHint(input: HintInput): Promise<HintView> {
  const { playerId, gameSessionId, roundIndex } = input;
  if (!playerId || !gameSessionId || typeof roundIndex !== "number") {
    throw new ApiError(400, "参数不完整");
  }
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：官阶模式需要数据库");

  const session = await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
    include: { answers: { select: { roundIndex: true } } },
  });
  if (!session || session.mode !== "POETRY" || session.kind !== "RANKED") {
    throw new ApiError(404, "对局不存在");
  }
  if (session.playerId !== playerId) {
    throw new ApiError(403, "无权操作该对局");
  }
  if (session.status !== "ACTIVE") throw new ApiError(410, "对局已结束");
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.gameSession.update({
      where: { id: gameSessionId },
      data: { status: "EXPIRED" },
    });
    throw new ApiError(410, "对局已超时");
  }
  if (roundIndex < 0 || roundIndex >= session.roundCount) {
    throw new ApiError(400, "轮次越界");
  }
  if (session.answers.some((a) => a.roundIndex === roundIndex)) {
    throw new ApiError(400, "该题已作答");
  }
  if (session.hintUsed) throw new ApiError(409, "本局已用过提示");

  const rounds = session.rounds as unknown as PoetryRound[];
  const round = rounds[roundIndex];
  // 被移除索引由服务端确定性 PRNG 产出；恒 2 个错误选项（纯函数合规校验见单测）
  const removedIndexes = pickHintRemoved(
    round.answerIndex,
    round.options.length,
    mulberry32(Date.now() % 2 ** 31),
  );
  // 原子抢占：hintUsed false→true（并发双请求仅 1 成功，输家 409）
  const claimed = await prisma.gameSession.updateMany({
    where: { id: gameSessionId, hintUsed: false },
    data: {
      hintUsed: true,
      hintRoundIndex: roundIndex,
      hintRemoved: removedIndexes as unknown as object[],
    },
  });
  if (claimed.count === 0) throw new ApiError(409, "本局已用过提示");
  return { removedIndexes };
}

/* ------------------------------------------------------------------ */
/* 剪影竞猜（D4 详设 §4.2）                                              */
/* ------------------------------------------------------------------ */

export interface GuessInput {
  playerId?: string;
  guessLabel?: string;
}

export interface GuessResultView {
  correct: boolean;
  gained: number;
  /** 当日已猜（重复提交返回原结果） */
  todayUsed: boolean;
}

/**
 * 剪影竞猜（D4 详设 §4.2，review A3）：
 * - 猜 rankId+2 迷雾阶称号（称号被 ？？？ 遮住——真正被隐藏的信息）；
 * - rankId >= 8（侍郎及以上）时 403（入口整体隐藏，皇帝信息拜相前绝不外露）；
 * - 每日 1 次（RankGuess 唯一键 playerId+date 幂等，重复提交返回原结果）；
 * - 猜中 +100 功名（playerRank.update 累加；不走 0.8 折价）。
 */
export async function submitRankGuess(input: GuessInput): Promise<GuessResultView> {
  const { playerId, guessLabel } = input;
  if (!playerId || typeof playerId !== "string" || typeof guessLabel !== "string") {
    throw new ApiError(400, "参数不完整");
  }
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：剪影竞猜需要数据库");
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { rank: true },
  });
  if (!player) throw new ApiError(404, "玩家不存在");
  const rankId = player.rank?.rank ?? 0;
  if (!isGuessAvailable(rankId)) {
    throw new ApiError(403, "本官阶已无迷雾阶可猜");
  }
  const date = localDate();
  const existing = await prisma.rankGuess.findUnique({
    where: { playerId_date: { playerId, date } },
  });
  if (existing) {
    return { correct: existing.correct, gained: existing.gained, todayUsed: true };
  }
  // 结算时刻读当前官阶判据（幂等：唯一键冲突 = 并发双提交，重查返回原结果）
  const target = guessTargetRank(rankId);
  if (!target) throw new ApiError(403, "本官阶已无迷雾阶可猜");
  const correct = guessLabel === target.label;
  const gained = correct ? GUESS_REWARD : 0;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.rankGuess.create({
        data: { playerId, date, guessLabel, correct, gained },
      });
      if (gained > 0) {
        const row = await tx.playerRank.findUnique({ where: { playerId } });
        const base = row?.totalExp ?? 0;
        await tx.playerRank.update({
          where: { playerId },
          data: { totalExp: base + gained },
        });
      }
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
    const race = await prisma.rankGuess.findUnique({
      where: { playerId_date: { playerId, date } },
    });
    if (race) {
      return { correct: race.correct, gained: race.gained, todayUsed: true };
    }
    throw err;
  }
  return { correct, gained, todayUsed: true };
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
  /** 开局时刻（P2 详设 §2.2：事件窗口按开局日判定，中途跨日不变） */
  createdAt: Date;
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
    //    select 含 roundIndex + 升序（review B5：maxCombo 按升序扫最大连续 correct 段）
    const answers = await tx.answerRecord.findMany({
      where: { sessionId: gameSessionId },
      select: { roundIndex: true, correct: true, gained: true },
      orderBy: { roundIndex: "asc" },
    });
    const correctCount = answers.filter((a) => a.correct).length;
    const totalRounds = answers.length;
    const sessionScore = answers.reduce((s, a) => s + a.gained, 0);
    const accuracy = totalRounds > 0
      ? Math.round((correctCount / totalRounds) * 100)
      : 0;
    // 最大连击（升序扫最大连续 correct 段，10 题规模 O(n)）
    let maxCombo = 0;
    let run = 0;
    for (const a of answers) {
      run = a.correct ? run + 1 : 0;
      if (run > maxCombo) maxCombo = run;
    }
    const clear = judgeClear(accuracy);

    // 问同窗折价（D4 详设 §4.1，review B4）：hintUsed 时本局功名 ×0.8。
    // 落库口径：GameSession.score 统一写折后值（= 实际入账功名），
    // recentGames / 功名簿柱状图直接取 score，全站一个口径。
    const sessHint = await tx.gameSession.findUnique({
      where: { id: gameSessionId },
      select: { hintUsed: true },
    });
    const hintUsed = sessHint?.hintUsed ?? false;
    const baseExp = hintUsed ? Math.round(sessionScore * 0.8) : sessionScore;

    // 限时事件功名加成（P2 详设 §2.2）：按开局日（GameSession.createdAt 所在
    // 日期，dateKey 注入 eventForDate 纯函数重算，确定性可复算）。
    // PRACTICE/DAILY 适用；EXAM 晋升判定只比正确率，功名入账不加成（event=null）。
    const event = input.kind === "EXAM"
      ? null
      : eventForDate(localDate(input.createdAt));
    const expGained = event
      ? Math.round(baseExp * event.expMultiplier)
      : baseExp;

    // 诗词阁落库（D3：结算事务内对本局全部轮次幂等入阁，含最后一题；
    // 崩溃恢复场景下重放结算可补齐——非末题判题时已入阁，upsert 无副作用）
    const sess = await tx.gameSession.findUnique({
      where: { id: gameSessionId },
      select: { rounds: true },
    });
    if (sess) {
      const sessRounds = sess.rounds as unknown as PoetryRound[];
      for (const r of sessRounds) {
        const a = answers.find((x) => x.roundIndex === r.roundIndex);
        if (a) await recordGallery(tx, playerId, r, a.correct);
      }
    }

    // 会话总分落库（与结算原子；score = 实际入账功名，review B4：hint 折后值）
    // accuracy 一并落库（D1 详设 §2.3 推荐口径：recentGames 展示直接取字段）
    await tx.gameSession.update({
      where: { id: gameSessionId },
      data: { score: expGained, accuracy },
    });

    // 每日题占位置已结算（详设 §2.1：DAILY 与 PRACTICE/EXAM 同通道结算，
    // 结算事务内补 playerDaily.settled = true）
    if (input.kind === "DAILY") {
      const dDate = localDate();
      await tx.playerDaily.updateMany({
        where: { playerId, date: dDate, sessionId: gameSessionId },
        data: { settled: true },
      });
    }

    // 4. 功名记账（单调累加：失败 / 弃局也保留已得功名）
    let rankRow = await tx.playerRank.findUnique({ where: { playerId } });
    if (!rankRow) {
      rankRow = await tx.playerRank.create({
        data: { playerId, rank: 0, totalExp: 0 },
      });
    }
    const currentRank = rankRow.rank;
    const totalExp = rankRow.totalExp + expGained;

    // 4b. 赛季惰性定格（P3-2 详设 §2.4 路径 1）：存档赛季 ≠ 当前赛季 →
    //     同事务先 SeasonBoard.upsert 定格旧赛季（幂等；旧季 seasonExp=0 无战绩
    //     不落快照，避免新档 "v1" 默认键产生噪音行），再切键清零重计 seasonExp。
    //     totalExp/rank 常青不动（功名只增不减红线）。
    const currentSeason = seasonKeyForDate(localDate());
    let seasonExp = rankRow.seasonExp;
    const seasonUpdate: { seasonKey?: string } = {};
    if (rankRow.seasonKey !== currentSeason) {
      if (rankRow.seasonExp > 0) {
        await tx.seasonBoard.upsert({
          where: { seasonKey_playerId: { seasonKey: rankRow.seasonKey, playerId } },
          create: {
            seasonKey: rankRow.seasonKey,
            playerId,
            rank: rankRow.rank,
            seasonExp: rankRow.seasonExp,
          },
          update: {},
        });
      }
      seasonUpdate.seasonKey = currentSeason;
      seasonExp = 0;
    }
    seasonExp += expGained;
    await tx.playerRank.update({
      where: { playerId },
      data: { totalExp, seasonExp, ...seasonUpdate },
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

    // 6. 周奖补记（review B3 追溯范围收敛：仅「最近 8 个已完结 ISO 周」内、
    //    PlayerDaily 历史可证真实连满且键未发过的周——不做全历史扫描；
    //    连满判定纯函数 completedWeeks，幂等键 = ISO 周键 YYYY-WW）
    const dailies = await tx.playerDaily.findMany({
      where: { playerId, date: { gte: `1970-01-01` } },
      select: { date: true, settled: true, madeUp: true },
    });
    const today = localDate();
    const newWeeklyKeys = completedWeeks(dailies, today).filter(
      (k) => !(rankRow.weeklyBonusKeys as unknown as string[]).includes(k),
    );
    if (newWeeklyKeys.length > 0) {
      const bonusExp = newWeeklyKeys.length * WEEKLY_BONUS_PER_WEEK;
      await tx.playerRank.update({
        where: { playerId },
        data: {
          totalExp: totalExp + bonusExp,
          // 周奖同属本赛季功名增量（P3-2：seasonExp 与 totalExp 同口径累加）
          seasonExp: seasonExp + bonusExp,
          weeklyBonusKeys: [
            ...(rankRow.weeklyBonusKeys as unknown as string[]),
            ...newWeeklyKeys,
          ],
        },
      });
      // 周奖功名计入本局实际入账（score = 实际入账功名，详设 §2.3 口径）
      await tx.gameSession.update({
        where: { id: gameSessionId },
        data: { score: expGained + bonusExp },
      });
    }

    // 7. 成就评估（事务尾：查持有集 → 纯函数评估 → createMany 新达成）
    const earnedRows = await tx.playerAchievement.findMany({
      where: { playerId },
      select: { key: true },
    });
    const earnedKeys = earnedRows.map((r) => r.key);
    const seenCount = await tx.playerSeenKey.count({
      where: { playerId, key: { contains: ":" } },
    });
    const weeksCompleted = completedWeeks(dailies, today).length;
    const ctx: AchievementCtx = {
      rankId: currentRank,
      newRank: promotion.newRank,
      promoted: promotion.promoted,
      correctCount,
      totalRounds,
      maxCombo,
      seenCount,
      weeksCompleted,
      kind: input.kind,
    };
    const newBadges = evaluateAchievements(ctx, earnedKeys);
    if (newBadges.length > 0) {
      await tx.playerAchievement.createMany({
        data: newBadges.map((key) => ({ playerId, key })),
      });
    }

    // 8. 皮肤解锁（P3-1 详设 §1.4：成就评估后按新达成 badge 解锁；幂等——
    //    已拥有集先查，skinsUnlockedByBadges 纯函数过滤，createMany 唯一键兜底）
    const ownedSkinRows = await tx.playerSkin.findMany({
      where: { playerId },
      select: { skinKey: true },
    });
    const newSkins = skinsUnlockedByBadges(
      newBadges,
      ownedSkinRows.map((r) => r.skinKey),
    );
    if (newSkins.length > 0) {
      // SQLite 连接器无 skipDuplicates：逐条 upsert 幂等（重放结算不炸唯一键）
      for (const skinKey of newSkins) {
        await tx.playerSkin.upsert({
          where: { playerId_skinKey: { playerId, skinKey } },
          create: { playerId, skinKey },
          update: {},
        });
      }
    }

    return {
      correctCount,
      totalRounds,
      accuracy,
      stars: clear.stars,
      expGained,
      totalExp,
      hintUsed,
      promotion,
      newBadges,
      event,
      // 结算台词（D1，详设 §1.2：按 kind 与 promotion.promoted 三分支；
      // P2 命中事件时尾部追加内侍播报句，不泄答案红线不变）
      settleLine:
        (input.kind !== "EXAM"
          ? practiceLine(expGained)
          : promotion.promoted
            ? promotionLine(
                personaFor("EXAM", input.rankId),
                RANKS[currentRank].label,
                RANKS[promotion.newRank].label,
              )
            : failLine(accuracy)) + (event ? eventLine(event.name, event.expMultiplier) : ""),
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
    settleLine: result.settleLine,
    newBadges: result.newBadges,
    hintUsed: result.hintUsed,
    event: result.event,
  };
}

/* ------------------------------------------------------------------ */
/* 官阶视图                                                            */
/* ------------------------------------------------------------------ */

/** 构建官阶进度视图（功名条 / 路线图数据源；D1 seenCount/recentGames + D2 badges/daily/corpusTotal） */
async function buildRankView(playerId: string): Promise<RankView> {
  const [row, seenCount, recentSessions, badgeRows, corpusTotal] = await Promise.all([
    prisma.playerRank.findUnique({ where: { playerId } }),
    // seenCount 口径（详设 §2.3，review A5）：只数 sourceKey 行（含冒号），
    // faceKey 行（竖线分隔，首段为题型枚举名）不重复计入。
    prisma.playerSeenKey.count({
      where: { playerId, key: { contains: ":" } },
    }),
    prisma.gameSession.findMany({
      where: { playerId, kind: "RANKED", status: "FINISHED" },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { stage: true, score: true, accuracy: true },
    }),
    prisma.playerAchievement.findMany({
      where: { playerId },
      select: { key: true },
    }),
    prisma.poem.count(),
  ]);
  // 每日题月历数据（当月 + 8 周回扫窗口，周连满判定用）
  const today = localDate();
  const [ty, tm] = today.slice(0, 8).split("-").map(Number);
  const todayD = Number(today.slice(8));
  const mondayOfToday =
    Date.UTC(ty, tm - 1, todayD) -
    (((new Date(Date.UTC(ty, tm - 1, todayD)).getUTCDay() || 7) - 1) * 86400000);
  const windowStart = mondayOfToday - 8 * 7 * 86400000;
  const startStr = new Date(windowStart).toISOString().slice(0, 10);
  const [monthRecords, historyRecords] = await Promise.all([
    prisma.playerDaily.findMany({
      where: { playerId, date: { gte: `${today.slice(0, 8)}01` } },
      select: { date: true, settled: true, madeUp: true },
    }),
    prisma.playerDaily.findMany({
      where: { playerId, date: { gte: startStr } },
      select: { date: true, settled: true, madeUp: true },
    }),
  ]);
  const monthStart = `${today.slice(0, 8)}01`;
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const madeUpThisMonth = monthRecords.filter((r) => r.madeUp).length;
  const weeksThisMonth = completedWeeksThisMonth(historyRecords, today);
  const daily: DailyView = {
    cells: buildMonthCells({
      monthStart,
      daysInMonth,
      today,
      records: monthRecords,
    }),
    weeksCompleted: weeksThisMonth,
    weeklyBonus: weeksThisMonth * WEEKLY_BONUS_PER_WEEK,
    makeupLeft: Math.max(0, MONTHLY_MAKEUP_QUOTA - madeUpThisMonth),
  };
  const rankId = row?.rank ?? 0;
  const totalExp = row?.totalExp ?? 0;
  const next = nextRank(rankId);
  // 皮肤视图（P3-1 详设 §1.4）：已拥有 key 集 + 穿戴位（脏数据防御：
  // 穿戴皮肤若不再合法（表移除/rank 不符——理论上皇帝皮肤恒合法），下发 null）
  const skinRows = await prisma.playerSkin.findMany({
    where: { playerId },
    select: { skinKey: true },
  });
  const ownedSkins = skinRows.map((r) => r.skinKey);
  const equippedRaw = row?.equippedSkin ?? null;
  const equipped =
    equippedRaw && canEquipSkin(equippedRaw, ownedSkins, rankId) ? equippedRaw : null;
  const skinView = { owned: ownedSkins, equipped };
  // 剪影竞猜（D4 详设 §4.2）：rankId>=8 时 null（入口整体隐藏，皇帝不外露）
  const guess = isGuessAvailable(rankId)
    ? await prisma.rankGuess.findUnique({
        where: { playerId_date: { playerId, date: today } },
        select: { correct: true, gained: true },
      }).then((g) => (g ? { done: true, correct: g.correct, gained: g.gained } : { done: false }))
    : null;
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
    seenCount,
    // expGained 取 score 字段（结算口径 = 实际入账功名，D4 后为 hint 折后值）；
    // accuracy 取结算事务写入的 GameSession.accuracy（D1 起落库，详设 §2.3 推荐口径）
    recentGames: recentSessions.map((s) => ({
      kind: kindOfStage(s.stage),
      expGained: s.score,
      accuracy: s.accuracy,
    })),
    badges: badgeRows.map((b) => b.key),
    daily,
    corpusTotal,
    guess,
    // 限时事件（P2 详设 §2.1）：当前生效事件（横幅数据源；无则 null）
    event: activeEvent(Date.now()),
    skins: skinView,
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

/* ------------------------------------------------------------------ */
/* 皮肤装备（P3-1 详设 §1.4：服务端权威裁决）                            */
/* ------------------------------------------------------------------ */

export interface SetSkinInput {
  playerId?: string;
  /** 皮肤 key；null = 卸下（回默认立绘） */
  skinKey?: string | null;
}

export interface SetSkinView {
  /** 装备后的穿戴位（与 RankView.skins.equipped 同口径） */
  equipped: string | null;
}

/**
 * 装备/卸下皮肤（POST /api/games/poetry/rank/skin 的薄壳目标）。
 * - skinKey = null：卸下，恒合法（有 PlayerRank 行即可）；
 * - 非 null：canEquipSkin 纯函数裁决（拥有 + rankId 匹配），不过 → 403；
 * - 幂等：重复装备同 key 结果不变。
 */
export async function setSkin(input: SetSkinInput): Promise<SetSkinView> {
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：衣冠需要数据库");
  const { playerId, skinKey } = input;
  if (!playerId || typeof playerId !== "string") throw new ApiError(400, "参数不完整");
  // 卸下必须显式传 null；undefined/非法类型一律 400
  if (skinKey !== null && typeof skinKey !== "string") throw new ApiError(400, "参数不完整");

  const rankRow = await prisma.playerRank.findUnique({ where: { playerId } });
  if (!rankRow) throw new ApiError(404, "玩家官阶档案不存在");

  if (skinKey !== null) {
    const ownedRows = await prisma.playerSkin.findMany({
      where: { playerId },
      select: { skinKey: true },
    });
    const owned = ownedRows.map((r) => r.skinKey);
    if (!canEquipSkin(skinKey, owned, rankRow.rank)) {
      throw new ApiError(403, "无权穿戴此衣冠");
    }
  }

  await prisma.playerRank.update({
    where: { playerId },
    data: { equippedSkin: skinKey ?? null },
  });
  return { equipped: skinKey ?? null };
}

/* ------------------------------------------------------------------ */
/* 功名簿视图（详设 §2.4：三区块数据源）                                 */
/* ------------------------------------------------------------------ */

/** 功名簿视图（GET /api/games/poetry/rank/ledger 的薄壳目标） */
export interface LedgerView {
  /** 成就 key 集（已获；未获由客户端拿 ACHIEVEMENTS 全表 diff 渲染剪影） */
  badges: string[];
  /** 每日题月历（与 RankView.daily 同源） */
  daily: DailyView;
  /** 累计功名（实际入账总功名） */
  totalExp: number;
  /** 已见题累计（review A5 口径：只数 sourceKey 行） */
  seenCount: number;
  /** 近 10 局功名柱状图（最新在后；score 即实际入账功名，与 recentGames 同源同口径，review C4） */
  recentBars: Array<{ kind: RankKind; exp: number }>;
}

/** 构建功名簿视图 */
export async function getLedgerView(playerId: string): Promise<LedgerView> {
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：功名簿需要数据库");
  if (!playerId || typeof playerId !== "string") throw new ApiError(400, "参数不完整");
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) throw new ApiError(404, "玩家不存在");

  const view = await buildRankView(playerId);
  // 近 10 局（最新在后 → 柱状图从左到右时间正序；recentGames 是最新在前，此处反向）
  const recent10 = await prisma.gameSession.findMany({
    where: { playerId, kind: "RANKED", status: "FINISHED" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { stage: true, score: true },
  });
  return {
    badges: view.badges,
    daily: view.daily,
    totalExp: view.totalExp,
    seenCount: view.seenCount,
    recentBars: recent10.reverse().map((s) => ({ kind: kindOfStage(s.stage), exp: s.score })),
  };
}

/* ------------------------------------------------------------------ */
/* 诗词阁（D3 详设 §3.1，GET 明文视图）                                  */
/* ------------------------------------------------------------------ */

/** 诗词阁视图（详设 §3.1 GalleryView） */
export interface GalleryView {
  /** 入阁诗数（按 poemId 去重） */
  total: number;
  /** 朝代分组（count 降序） */
  byDynasty: Array<{ dynasty: string; count: number }>;
  /** 学段分组（grade 升序） */
  byGrade: Array<{ grade: number; count: number }>;
  /** 分页诗卡（page 从 1，pageSize 默认 20；seenAt desc） */
  items: Array<{
    title: string;
    poet: string;
    dynasty: string;
    grade: number;
    mastered: boolean;
    seenAt: string;
    lines: string[];
  }>;
}

/**
 * 诗词阁视图：玩家答过的诗（答过即入库，不论对错）。
 * lines 全文从 Poem 语料表回填（公版语料，明文可下发）。
 */
export async function getGalleryView(
  playerId: string,
  page: number = 1,
  pageSize: number = 20,
  opts: { dynasty?: string | null; grade?: number | null } = {},
): Promise<GalleryView> {
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：诗词阁需要数据库");
  if (!playerId || typeof playerId !== "string") throw new ApiError(400, "参数不完整");
  const p = Math.max(1, Math.floor(page) || 1);
  const ps = Math.min(100, Math.max(1, Math.floor(pageSize) || 20));
  // 过滤条件（朝代 / 学段，仅作用于 items 分页；分组统计恒为全量）
  const where: {
    playerId: string;
    dynasty?: string;
    grade?: number;
  } = { playerId };
  if (opts.dynasty) where.dynasty = opts.dynasty;
  if (opts.grade !== null && opts.grade !== undefined) where.grade = opts.grade;

  const [total, dynastyRows, gradeRows, items] = await Promise.all([
    // total = 全量入阁数（详设 §3.1：进度条分子，不随过滤变）；过滤只作用于 items
    prisma.playerPoem.count({ where: { playerId } }),
    prisma.playerPoem.groupBy({
      by: ["dynasty"],
      where: { playerId },
      _count: { _all: true },
      orderBy: { _count: { dynasty: "desc" } },
    }),
    prisma.playerPoem.groupBy({
      by: ["grade"],
      where: { playerId },
      _count: { _all: true },
      orderBy: { grade: "asc" },
    }),
    prisma.playerPoem.findMany({
      where,
      orderBy: { seenAt: "desc" },
      skip: (p - 1) * ps,
      take: ps,
    }),
  ]);
  const poemIds = items.map((i) => i.poemId);
  const poemRows = poemIds.length
    ? await prisma.poem.findMany({
        where: { id: { in: poemIds } },
        select: { id: true, lines: true },
      })
    : [];
  const linesByPoemId = new Map<string, string[]>(
    poemRows.map((pm) => [pm.id, pm.lines as unknown as string[]]),
  );
  return {
    total,
    byDynasty: dynastyRows.map((r) => ({ dynasty: r.dynasty, count: r._count._all })),
    byGrade: gradeRows.map((r) => ({ grade: r.grade, count: r._count._all })),
    items: items.map((i) => ({
      title: i.title,
      poet: i.poet,
      dynasty: i.dynasty,
      grade: i.grade,
      mastered: i.mastered,
      seenAt: i.seenAt.toISOString(),
      lines: linesByPoemId.get(i.poemId) ?? [],
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 刷新恢复：取玩家未完成的官阶局                                        */
/* ------------------------------------------------------------------ */
/** 可恢复的官阶局视图（刷新后继续作答） */
export interface RankedResumeView {
  gameSessionId: string;
  kind: RankKind;
  rankId: number;
  label: string;
  expiresAt: string;
  /** 已作答轮次（客户端跳过，从第一个未答的继续） */
  answeredIndexes: number[];
  /** 当前累计分 */
  score: number;
  rounds: PoetryRoundView[];
  /** 本局人设与开局白（D1：与 start 视图同口径，同会话同句） */
  persona: PersonaKey;
  opening: string;
  /** 问同窗灰置（D4 详设 §4.1，review A9）：客户端仅当 roundIndex === currentIndex 时灰置，答过该题后自然失效 */
  hint: { roundIndex: number; removedIndexes: number[] } | null;
  /** 开局锁定的限时事件（P2 详设 §2.2）：与 start 视图同口径（按开局日重算） */
  event: string | null;
}

/**
 * 取玩家最近一局未结束（ACTIVE 且未超时）的官阶局。
 * 无则返回 null（前端回落到官途主页）。
 */
export async function resumeRankedSession(
  playerId: string,
): Promise<RankedResumeView | null> {
  const useDb = await isDbAvailable();
  if (!useDb) throw new ApiError(503, "DB_UNAVAILABLE：官阶模式需要数据库");
  if (!playerId || typeof playerId !== "string") throw new ApiError(400, "参数不完整");
  const session = await prisma.gameSession.findFirst({
    where: {
      playerId,
      mode: "POETRY",
      kind: "RANKED",
      status: "ACTIVE",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    include: { answers: { select: { roundIndex: true } } },
  });
  if (!session) return null;
  const kind = kindOfStage(session.stage);
  const persona = personaFor(kind, session.rankId ?? 0);
  return {
    gameSessionId: session.id,
    kind,
    rankId: session.rankId ?? 0,
    label: RANKS[session.rankId ?? 0].label,
    expiresAt: session.expiresAt.toISOString(),
    answeredIndexes: session.answers.map((a) => a.roundIndex),
    score: session.score,
    rounds: (session.rounds as unknown as PoetryRound[]).map(toRoundView),
    persona,
    opening: openingLine(persona, hashIdToSeed(session.id)),
    hint:
      session.hintUsed && session.hintRoundIndex !== null
        ? {
            roundIndex: session.hintRoundIndex,
            removedIndexes: session.hintRemoved as unknown as number[],
          }
        : null,
    // 限时事件（P2 详设 §2.2）：按开局日重算，与 start 视图同口径
    event: eventForDate(localDate(session.createdAt))?.id ?? null,
  };
}
