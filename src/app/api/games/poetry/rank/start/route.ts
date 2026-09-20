import { withCrypto } from "@/lib/crypto/with-crypto";
import { startRankedSession, StartRankedInput } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 官阶开局（事务选题 + 占用已见；题量不足 / 功名不达标 / 越级均如实上报） */
export const POST = withCrypto(
  async (body) => startRankedSession((body ?? {}) as StartRankedInput),
);
