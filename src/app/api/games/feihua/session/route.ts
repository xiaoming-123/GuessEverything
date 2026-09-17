import { withCrypto } from "@/lib/crypto/with-crypto";
import {
  startFeihuaSession,
  StartFeihuaSessionInput,
  StartFeihuaSessionView,
} from "@/lib/db/feihua-session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 开局：飞花令出题（答案永不下发） */
export const POST = withCrypto(
  async (body): Promise<StartFeihuaSessionView> =>
    startFeihuaSession((body ?? {}) as StartFeihuaSessionInput),
);
