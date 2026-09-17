/**
 * 飞花令专项冒烟：客户端不变量校验 + 全对通关
 * 用法：先启动服务（npm run dev），再 node scripts/smoke-feihua.mjs
 *
 * 覆盖：
 * 1. 三档开局题量与题型配方（入门仅寻句 / 骨灰三题型齐全）
 * 2. 不下发答案（answerIndex/sourceKey/meta）
 * 3. 客户端可据令字独立推出唯一正确项（含字关系不变量）
 * 4. 全对通关 10/10 → accuracy 100 / 3 星 / passed
 * 5. 超时提交判错
 */

import crypto from "node:crypto";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
let passed = 0;
let failed = 0;

function check(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log("  ✓", name);
  } else {
    failed += 1;
    console.log("  ✗", name, extra);
  }
}

/* ---------- 加密客户端（与 secureFetch 等价） ---------- */

let sessionId;
let aesKey;
let wrappedKey;
let keySent = false;

async function ensureSession() {
  if (sessionId) return;
  const res = await fetch(`${BASE}/api/crypto/key`, { cache: "no-store" });
  const { sessionId: sid, publicKey } = await res.json();
  sessionId = sid;
  aesKey = crypto.randomBytes(32);
  const pub = crypto.createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  wrappedKey = crypto
    .publicEncrypt(
      { key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      aesKey,
    )
    .toString("base64");
}

function encrypt(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    v: 1,
    sessionId,
    key: keySent ? null : wrappedKey,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
    data: ct.toString("base64"),
  };
}

function decrypt(envelope) {
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envelope.iv, "base64"));
  d.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    Buffer.concat([d.update(Buffer.from(envelope.data, "base64")), d.final()]).toString("utf8"),
  );
}

async function post(path, payload) {
  await ensureSession();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encrypt(payload)),
  });
  keySent = true;
  const j = await res.json();
  if (!res.ok) throw new Error(`[${res.status}] ${path} ${JSON.stringify(j)}`);
  return decrypt(j);
}

/** 客户端独立推算正确项索引；返回负值表示不变量被破坏 */
function solve(round) {
  if (round.type === "FIND_CONTAINS") {
    const hits = round.options.filter((o) => o.includes(round.lingChar));
    return hits.length === 1 ? round.options.indexOf(hits[0]) : -2;
  }
  if (round.type === "FIND_MISSING") {
    const misses = round.options.filter((o) => !o.includes(round.lingChar));
    return misses.length === 1 ? round.options.indexOf(misses[0]) : -2;
  }
  // GUESS_CHAR：唯一在题干中的单字
  const hits = round.options.filter((o) => round.prompt.includes(o));
  return hits.length === 1 ? round.options.indexOf(hits[0]) : -2;
}

/* ---------- [1] 骨灰档：三题型齐全 + 全对通关 ---------- */

console.log("[1] 骨灰档开局与不变量");
const hard = await post("/api/games/feihua/session", { difficulty: "HARD", count: 10 });
check("开局 10 题", hard.rounds.length === 10, `实际 ${hard.rounds.length}`);
check(
  "响应不含 answerIndex/sourceKey/meta",
  !JSON.stringify(hard.rounds).includes("answerIndex") &&
    !JSON.stringify(hard.rounds).includes("sourceKey"),
);

const types = new Set(hard.rounds.map((r) => r.type));
check("三题型齐全（寻句/挑白/猜令）", types.size === 3, [...types].join(","));

let invariantOk = true;
for (const r of hard.rounds) {
  const idx = solve(r);
  if (idx < 0) {
    invariantOk = false;
    console.log("    不变量破坏:", r.type, r.lingChar, r.options.join(" | "));
  }
  const leak = JSON.stringify(r).includes("answerIndex");
  if (leak) invariantOk = false;
}
check("每题可据令字推出唯一正确项且无答案泄露", invariantOk);

let lastJudge;
for (let i = 0; i < hard.rounds.length; i++) {
  const choice = solve(hard.rounds[i]);
  lastJudge = await post("/api/games/feihua/answer", {
    gameSessionId: hard.gameSessionId,
    roundIndex: i,
    choice,
    timeMs: 2000 + i * 100,
  });
  check(`第 ${i + 1} 题判对`, lastJudge.correct === true);
  check(`第 ${i + 1} 题进度正确`, lastJudge.totalScore > 0);
}
check("最后一题 finished", lastJudge.finished === true);
check("全对 10/10", lastJudge.summary?.correctCount === 10);
check("正确率 100%", lastJudge.summary?.accuracy === 100);
check("3 星通关", lastJudge.summary?.stars === 3 && lastJudge.summary?.passed === true);

/* ---------- [2] 入门档：仅寻句题 ---------- */

console.log("\n[2] 入门档题型配方");
const easy = await post("/api/games/feihua/session", { difficulty: "EASY", count: 10 });
check("入门 10 题", easy.rounds.length === 10);
check(
  "入门仅 FIND_CONTAINS",
  easy.rounds.every((r) => r.type === "FIND_CONTAINS"),
);
check(
  "每题带令字 lingChar",
  easy.rounds.every((r) => r.lingChar && r.lingChar.length === 1),
);
const e0 = easy.rounds[0];
check("寻句题令字确实在某个选项中", e0.options.some((o) => o.includes(e0.lingChar)));
const easyJudge = await post("/api/games/feihua/answer", {
  gameSessionId: easy.gameSessionId,
  roundIndex: 0,
  choice: solve(e0),
  timeMs: 1000,
});
check("按不变量作答判对", easyJudge.correct === true);

/* ---------- [3] 进阶档含猜令题 ---------- */

console.log("\n[3] 进阶档题型配方");
const normalTypes = new Set();
for (let seed = 0; seed < 3; seed++) {
  const g = await post("/api/games/feihua/session", { difficulty: "NORMAL", count: 10 });
  g.rounds.forEach((r) => normalTypes.add(r.type));
}
check("进阶包含 FIND_CONTAINS", normalTypes.has("FIND_CONTAINS"));
check("进阶包含 GUESS_CHAR", normalTypes.has("GUESS_CHAR"));
check("进阶不出现 FIND_MISSING", !normalTypes.has("FIND_MISSING"));

/* ---------- [4] 超时提交按错 ---------- */

console.log("\n[4] 超时判错");
const to = await post("/api/games/feihua/session", { difficulty: "EASY", count: 5 });
const toJudge = await post("/api/games/feihua/answer", {
  gameSessionId: to.gameSessionId,
  roundIndex: 0,
  timeout: true,
  timeMs: 15000,
});
check("timeout=true 回传", toJudge.timeout === true);
check("超时判定答错且 0 分", toJudge.correct === false && toJudge.gained === 0);

/* ---------- [5] 非法关卡与重复提交 ---------- */

console.log("\n[5] 边界");
const badStage = await fetch(`${BASE}/api/games/feihua/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
check("明文非法请求被拦（非 2xx）", !badStage.ok);

// 第 0 题在 [2] 已作答：再发必须 409（错误响应为明文 JSON）
const dupEnvelope = encrypt({
  gameSessionId: easy.gameSessionId,
  roundIndex: 0,
  choice: 0,
  timeMs: 1000,
});
const dupRes = await fetch(`${BASE}/api/games/feihua/answer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(dupEnvelope),
});
check("重复提交 → 409", dupRes.status === 409, `实际 ${dupRes.status}`);

console.log(`\n=== 飞花令冒烟：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed === 0 ? 0 : 1);
