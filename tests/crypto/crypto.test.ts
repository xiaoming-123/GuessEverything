import { describe, expect, it, beforeEach } from "vitest";
import crypto from "node:crypto";
import { checkAndConsumeNonce, clearNonces } from "@/lib/crypto/nonce";
import { CryptoError, verifyFreshness, type Envelope } from "@/lib/crypto/protocol";
import { getServerKeys } from "@/lib/crypto/keys";
import { clearSessionKeys, resolveSessionKey } from "@/lib/crypto/session-keys";
import { withCrypto } from "@/lib/crypto/with-crypto";

describe("verifyFreshness", () => {
  const base: Envelope = {
    v: 1,
    sessionId: "s1",
    key: null,
    iv: "iv",
    tag: "tag",
    ts: Date.now(),
    nonce: "abc",
    data: "data",
  };

  it("合法信封通过", () => {
    expect(() => verifyFreshness(base)).not.toThrow();
  });

  it("版本不符抛 ENVELOPE_INVALID", () => {
    expect(() => verifyFreshness({ ...base, v: 99 })).toThrowError(CryptoError);
  });

  it("时间戳超偏移抛 STALE_REQUEST", () => {
    expect(() => verifyFreshness({ ...base, ts: Date.now() - 10 * 60_000 })).toThrowError(
      CryptoError,
    );
  });
});

describe("nonce 防重放", () => {
  beforeEach(() => clearNonces());

  it("首次消费返回 true，重复消费返回 false", () => {
    expect(checkAndConsumeNonce("n1")).toBe(true);
    expect(checkAndConsumeNonce("n1")).toBe(false);
    expect(checkAndConsumeNonce("n2")).toBe(true);
  });
});

describe("加密信封端到端（模拟客户端完整握手）", () => {
  beforeEach(() => {
    clearNonces();
    clearSessionKeys();
    clientAesKey = crypto.randomBytes(32);
  });

  /** 模拟客户端持有的 AES 会话密钥（整个会话复用同一把） */
  let clientAesKey: Buffer;

  /** 模拟客户端：AES 加密业务数据 → 构造信封（key 选项仅用于模拟首包/后续包） */
  function buildEnvelope(payload: unknown, opts?: { key?: string | null }): Envelope {
    const { publicKeyBase64 } = getServerKeys();
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const wrapped = crypto
      .publicEncrypt(
        {
          key: publicKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        clientAesKey,
      )
      .toString("base64");

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", clientAesKey, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: 1,
      sessionId: "test-session",
      key: opts?.key !== undefined ? opts.key : wrapped,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ts: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex"),
      data: ct.toString("base64"),
    };
  }

  /** 模拟客户端：解密服务端响应 */
  function openResponse(aesKey: Buffer, resp: Record<string, unknown>): unknown {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      aesKey,
      Buffer.from(resp.iv as string, "base64"),
    );
    decipher.setAuthTag(Buffer.from(resp.tag as string, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(resp.data as string, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(pt.toString("utf8"));
  }

  it("首请求携带封装密钥：解密业务数据 → 明文进入 handler → 响应可解密", async () => {
    const handler = withCrypto((body) => ({ echo: body, ok: true }));
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEnvelope({ hello: "谜盒" })),
    });

    const res = await handler(request as never);
    expect(res.status).toBe(200);

    const resp = await res.json();
    // 服务端缓存的会话密钥与客户端持有的一致，可解密响应
    const cached = resolveSessionKey("test-session", null);
    expect(cached).toEqual(clientAesKey);
    expect(openResponse(cached, resp)).toEqual({ echo: { hello: "谜盒" }, ok: true });
  });

  it("后续请求不携带 key：走缓存密钥", async () => {
    const handler = withCrypto((body) => ({ got: body }));
    const makeReq = (env: Envelope) =>
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
      }) as never;

    await handler(makeReq(buildEnvelope({ n: 1 })));
    const res2 = await handler(makeReq(buildEnvelope({ n: 2 }, { key: null })));
    const resp = await res2.json();
    const cached = resolveSessionKey("test-session", null);
    expect(openResponse(cached, resp)).toEqual({ got: { n: 2 } });
  });

  it("缓存未命中且无封装密钥：401 会话过期", async () => {
    const handler = withCrypto(() => ({}));
    const env = buildEnvelope({});
    env.sessionId = "fresh-unknown-session";
    env.key = null;
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    const res = await handler(request as never);
    expect(res.status).toBe(401);
  });

  it("同一 nonce 重放：400 拒绝", async () => {
    const handler = withCrypto(() => ({}));
    const env = buildEnvelope({});
    const makeReq = () =>
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
      });
    const first = await handler(makeReq() as never);
    expect(first.status).toBe(200);
    const replay = await handler(makeReq() as never);
    expect(replay.status).toBe(400);
    const body = await replay.json();
    expect(body.error.code).toBe("REPLAY_DETECTED");
  });
});
