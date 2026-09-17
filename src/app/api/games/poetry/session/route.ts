import { withCrypto } from "@/lib/crypto/with-crypto";
import {
  startPoetrySession,
  StartSessionInput,
  StartSessionView,
} from "@/lib/db/session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 开局：出题（答案永不下发） */
export const POST = withCrypto(
  async (body): Promise<StartSessionView> => startPoetrySession((body ?? {}) as StartSessionInput),
);
