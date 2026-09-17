/**
 * P0 冒烟测试：模拟加密客户端走完整 HTTP 闭环
 * 用法：先启动服务（npm run start / dev），再 node scripts/smoke-client.mjs
 */

import crypto from "node:crypto";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

/* ---------- 客户端加密层（与服务端 secureFetch 等价的 Node 版） ---------- */

let sessionId;
let aesKey;
let keySent = false;

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

async function ensureSession() {
  if (sessionId) return;
  const res = await fetch(`${BASE}/api/crypto/key`, { cache: "no-store" });
  if (!res.ok) throw new Error(`密钥交换失败: ${res.status}`);
  const { sessionId: sid, publicKey } = await res.json();
  sessionId = sid;
  aesKey = crypto.randomBytes(32);
  const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  wrappedKey = crypto
    .publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey)
    .toString("base64");
}

let wrappedKey;

function encrypt(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    v: 1,
    sessionId,
    key: keySent ? null : wrappedKey,
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
    data: b64(ct),
  };
}

function decrypt(envelope) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

async function securePost(path, payload) {
  await ensureSession();
  const body = encrypt(payload);
  keySent = true;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await res.json();
  if (!res.ok) throw new Error(`[${res.status}] ${JSON.stringify(resp)}`);
  return decrypt(resp);
}

/* ---------- 冒烟流程 ---------- */

const start = await securePost("/api/games/poetry/session", { stage: "PRIMARY", count: 10 });
console.log("✓ 开局成功");
console.log("  gameSessionId:", start.gameSessionId);
console.log("  题目数:", start.rounds.length, "| 首题:", start.rounds[0].prompt);
console.log("  选项:", start.rounds[0].options.join(" / "));

if (JSON.stringify(start.rounds[0]).includes("answerIndex")) {
  throw new Error("✗ 安全违规：响应中包含 answerIndex！");
}
console.log("✓ 响应中无答案字段");

const judge = await securePost("/api/games/poetry/answer", {
  gameSessionId: start.gameSessionId,
  roundIndex: 0,
  choice: 0,
  timeMs: 3200,
});
console.log("✓ 判题成功");
console.log("  判定:", judge.correct ? "答对" : "答错", "| 正确答案:", judge.correctAnswer);
console.log("  本题得分:", judge.gained, "| 累计:", judge.totalScore, "| 倍率:", judge.multiplier);
console.log("  解析:", judge.explanation);

// 防重放验证：先发送一个合法信封，再把【完全相同】的信封重发，必须被拒绝
const firstBody = encrypt({ gameSessionId: start.gameSessionId, roundIndex: 1, choice: 0, timeMs: 100 });
keySent = true;
const firstRes = await fetch(`${BASE}/api/games/poetry/answer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(firstBody),
});
console.log(firstRes.status === 200 ? "✓ 首次请求正常 (200)" : `✗ 首次请求异常 (status=${firstRes.status})`);

const replayRes = await fetch(`${BASE}/api/games/poetry/answer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(firstBody),
});
if (replayRes.status !== 400) throw new Error(`✗ 重放未被拦截 (status=${replayRes.status})`);
console.log("✓ 重放请求被拒绝 (400)");

/* ---------- 演员猜猜闭环 ---------- */

const actorStart = await securePost("/api/games/actor/session", { difficulty: "EASY", count: 10 });
console.log("\n✓ 演员玩法开局成功");
console.log("  gameSessionId:", actorStart.gameSessionId);
console.log("  题目数:", actorStart.rounds.length, "| 首题:", actorStart.rounds[0].prompt);
console.log("  选项:", actorStart.rounds[0].options.join(" / "));

if (JSON.stringify(actorStart.rounds[0]).includes("answerIndex")) {
  throw new Error("✗ 安全违规：演员题响应中包含 answerIndex！");
}
console.log("✓ 演员题响应中无答案字段");

const actorJudge = await securePost("/api/games/actor/answer", {
  gameSessionId: actorStart.gameSessionId,
  roundIndex: 0,
  choice: 0,
  timeMs: 2800,
});
console.log("✓ 演员题判题成功");
console.log("  判定:", actorJudge.correct ? "答对" : "答错", "| 正确答案:", actorJudge.correctAnswer);
console.log("  本题得分:", actorJudge.gained, "| 累计:", actorJudge.totalScore);
console.log("  解析:", actorJudge.explanation);

/* ---------- 物品猜猜闭环 ---------- */

const objectStart = await securePost("/api/games/object/session", { difficulty: "EASY", count: 10 });
console.log("\n✓ 物品玩法开局成功");
console.log("  gameSessionId:", objectStart.gameSessionId);
console.log("  题目数:", objectStart.rounds.length, "| 首题:", objectStart.rounds[0].prompt);
console.log("  选项:", objectStart.rounds[0].options.join(" / "));

if (JSON.stringify(objectStart.rounds[0]).includes("answerIndex")) {
  throw new Error("✗ 安全违规：物品题响应中包含 answerIndex！");
}
if (JSON.stringify(objectStart.rounds[0]).includes("riddle")) {
  throw new Error("✗ 安全违规：物品题响应中包含 riddle 谜底元数据！");
}
console.log("✓ 物品题响应中无答案字段");

const objectJudge = await securePost("/api/games/object/answer", {
  gameSessionId: objectStart.gameSessionId,
  roundIndex: 0,
  choice: 0,
  timeMs: 2600,
});
console.log("✓ 物品题判题成功");
console.log("  判定:", objectJudge.correct ? "答对" : "答错", "| 正确答案:", objectJudge.correctAnswer);
console.log("  本题得分:", objectJudge.gained, "| 累计:", objectJudge.totalScore);
console.log("  解析:", objectJudge.explanation);

/* ---------- 飞花令闭环 ---------- */

const feihuaStart = await securePost("/api/games/feihua/session", { difficulty: "HARD", count: 10 });
console.log("\n✓ 飞花令开局成功");
console.log("  gameSessionId:", feihuaStart.gameSessionId);
console.log("  题目数:", feihuaStart.rounds.length, "| 首题类型:", feihuaStart.rounds[0].type);
const f0 = feihuaStart.rounds[0];
console.log(
  "  首题:",
  f0.type === "GUESS_CHAR" ? f0.prompt : `令字「${f0.lingChar}」`,
);
console.log("  选项:", f0.options.join(" / "));

if (JSON.stringify(f0).includes("answerIndex") || JSON.stringify(f0).includes("sourceKey")) {
  throw new Error("✗ 安全违规：飞花令响应中包含答案字段！");
}
console.log("✓ 飞花令响应中无答案字段");

const feihuaJudge = await securePost("/api/games/feihua/answer", {
  gameSessionId: feihuaStart.gameSessionId,
  roundIndex: 0,
  choice: 0,
  timeMs: 2600,
});
console.log("✓ 飞花令判题成功");
console.log(
  "  判定:",
  feihuaJudge.correct ? "答对" : "答错",
  "| 正确答案:",
  feihuaJudge.correctAnswer,
);
console.log("  本题得分:", feihuaJudge.gained, "| 累计:", feihuaJudge.totalScore);
console.log("  解析:", feihuaJudge.explanation);

console.log("\n=== 冒烟测试全部通过（诗词 + 演员 + 物品 + 飞花令） ===");
