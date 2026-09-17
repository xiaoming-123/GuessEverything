import { withCrypto } from "@/lib/crypto/with-crypto";
import {
  startActorSession,
  StartActorSessionInput,
  StartActorSessionView,
} from "@/lib/db/actor-session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 开局：出题（答案永不下发） */
export const POST = withCrypto(
  async (body): Promise<StartActorSessionView> =>
    startActorSession((body ?? {}) as StartActorSessionInput),
);
