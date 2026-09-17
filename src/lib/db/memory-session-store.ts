/**
 * 内存会话兜底存储（开发 / 演示用）
 *
 * 数据库未配置或不可用时，对局闭环仍可完整跑通；
 * 仅存进程内存，重启即失，生产环境务必配置 DATABASE_URL。
 */

import type { PoetryRound } from "@/lib/games/poetry/types";
import type { ActorRound } from "@/lib/games/actor/types";
import type { ObjectRound } from "@/lib/games/object/types";
import type { FeihuaRound } from "@/lib/games/feihua/types";

/** 各玩法轮次结构（均含 answerIndex/meta，仅服务端持有） */
export type SessionRounds = PoetryRound[] | ActorRound[] | ObjectRound[] | FeihuaRound[];

export interface MemAnswer {
  sessionId: string;
  roundIndex: number;
  given: string;
  correct: boolean;
  correctAnswer: string;
  timeMs: number;
}

export interface MemSession {
  id: string;
  mode: string;
  stage: string;
  rounds: SessionRounds;
  roundCount: number;
  status: string;
  score: number;
  expiresAt: Date;
  answers: Map<number, MemAnswer>;
}

const globalForMem =
  globalThis as unknown as { __mysteryBoxMemSessions?: Map<string, MemSession> };

function store(): Map<string, MemSession> {
  globalForMem.__mysteryBoxMemSessions ??= new Map();
  return globalForMem.__mysteryBoxMemSessions;
}

export function memCreate(session: MemSession): void {
  store().set(session.id, session);
}

export function memGet(id: string): MemSession | undefined {
  return store().get(id);
}

export function memUpdate(
  id: string,
  patch: Partial<Pick<MemSession, "status" | "score">>,
): void {
  const s = store().get(id);
  if (!s) return;
  Object.assign(s, patch);
}

export function memUpsertAnswer(answer: MemAnswer): void {
  const s = store().get(answer.sessionId);
  if (!s) return;
  s.answers.set(answer.roundIndex, answer);
}

/** 测试辅助：清空 */
export function clearMemSessions(): void {
  store().clear();
}
