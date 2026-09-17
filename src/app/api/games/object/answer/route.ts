import { withCrypto } from "@/lib/crypto/with-crypto";
import {
  ObjectAnswerInput,
  ObjectAnswerView,
  judgeObjectAnswer,
} from "@/lib/db/object-session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 判题：服务端比对答案，返回判题结果与累计分 */
export const POST = withCrypto(
  async (body): Promise<ObjectAnswerView> =>
    judgeObjectAnswer((body ?? {}) as ObjectAnswerInput),
);
