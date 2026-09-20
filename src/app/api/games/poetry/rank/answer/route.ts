import { withCrypto } from "@/lib/crypto/with-crypto";
import { judgeRankedAnswer, RankedJudgeInput } from "@/lib/db/rank-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 官阶判题（服务端比对答案；答完最后一题触发一次性结算 + 晋升） */
export const POST = withCrypto(
  async (body) => judgeRankedAnswer((body ?? {}) as RankedJudgeInput),
);
