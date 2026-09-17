/**
 * 判题边界场景测试（需 dev/prod 服务运行中）
 * 用法：node scripts/smoke-edge.mjs
 */

import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const prisma = new PrismaClient();

let sessionId, aesKey, wrappedKey, keySent = false;
const b64 = (b) => Buffer.from(b).toString("base64");

async function ensure() {
  if (sessionId) return;
  const { sessionId: sid, publicKey } = await (await fetch(`${BASE}/api/crypto/key`)).json();
  sessionId = sid;
  aesKey = crypto.randomBytes(32);
  const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  wrappedKey = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey).toString("base64");
}

function enc(payload) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return { v: 1, sessionId, key: keySent ? null : wrappedKey, iv: b64(iv), tag: b64(c.getAuthTag()), ts: Date.now(), nonce: crypto.randomBytes(16).toString("hex"), data: b64(ct) };
}

function dec(e) {
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(e.iv, "base64"));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString());
}

async function rawPost(path, payload) {
  await ensure();
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(enc(payload)) });
  keySent = true;
  const j = await res.json();
  // 成功响应是加密信封，错误响应是明文
  return { status: res.status, body: res.ok ? dec(j) : j };
}

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

async function openSession(payload) {
  const s = await rawPost("/api/games/poetry/session", payload);
  if (!s.body.gameSessionId) {
    console.log(`  ! 开局失败 [${s.status}] ${JSON.stringify(s.body).slice(0, 200)}`);
    return null;
  }
  return s.body.gameSessionId;
}

/* ---------- 场景 ---------- */

// 1. 重复判题刷分
console.log("[1] 同一轮重复提交（防刷分）");
{
  const gid = await openSession({ stage: "PRIMARY", count: 5 });
  const r1 = await rawPost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: 0, choice: 0, timeMs: 1000 });
  const r2 = await rawPost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: 0, choice: 1, timeMs: 1000 });
  check("开局成功", gid !== null);
  check("首次提交 200", r1.status === 200, `实际 ${r1.status} ${JSON.stringify(r1.body).slice(0, 120)}`);
  check("重复提交被拒绝(409)", r2.status === 409, `实际 ${r2.status} ${JSON.stringify(r2.body).slice(0, 120)}`);
}

// 2. 轮次越界 / 负数
console.log("[2] 轮次越界");
{
  const s = await rawPost("/api/games/poetry/session", { stage: "PRIMARY", count: 5 });
  const gid = s.body.gameSessionId;
  const over = await rawPost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: 99, choice: 0, timeMs: 100 });
  const neg = await rawPost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: -1, choice: 0, timeMs: 100 });
  check("roundIndex=99 → 400", over.status === 400, `实际 ${over.status}`);
  check("roundIndex=-1 → 400", neg.status === 400, `实际 ${neg.status}`);
}

// 3. 答完最后一题后再提交
console.log("[3] 对局结束后再提交");
{
  const gid = await openSession({ stage: "PRIMARY", count: 5 });
  if (gid) {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await rawPost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: i, choice: 0, timeMs: 100 });
      statuses.push(r.status);
    }
    check("5 题全部提交成功", statuses.every((x) => x === 200), `实际 ${statuses.join(",")}`);
    const after = await rawPost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: 0, choice: 0, timeMs: 100 });
    check("结束后提交 → 410", after.status === 410, `实际 ${after.status}`);
  } else check("开局成功", false);
}

// 4. choice 选项越界
console.log("[4] 选项索引越界");
{
  const s = await rawPost("/api/games/poetry/session", { stage: "PRIMARY", count: 5 });
  const gid = s.body.gameSessionId;
  const bad = await rawPost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: 0, choice: 99, timeMs: 100 });
  check("choice=99 → 400", bad.status === 400, `实际 ${bad.status} ${JSON.stringify(bad.body).slice(0, 80)}`);
}

// 5. 不存在的会话 / 参数缺失
console.log("[5] 非法会话与参数");
{
  const noSess = await rawPost("/api/games/poetry/answer", { gameSessionId: "nonexistent-id", roundIndex: 0, choice: 0, timeMs: 100 });
  check("不存在会话 → 404", noSess.status === 404, `实际 ${noSess.status}`);
  const noArg = await rawPost("/api/games/poetry/answer", { roundIndex: 0, choice: 0 });
  check("缺 sessionId → 400", noArg.status === 400, `实际 ${noArg.status}`);
}

// 6. 过期会话（直接改 DB 的 expiresAt）
console.log("[6] 会话过期");
{
  const gid = await openSession({ stage: "PRIMARY", count: 5 });
  if (gid) {
    await prisma.gameSession.update({ where: { id: gid }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await rawPost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: 0, choice: 0, timeMs: 100 });
    check("过期会话 → 410", expired.status === 410, `实际 ${expired.status}`);
  } else check("开局成功", false);
}

// 7. seed 幂等重跑
console.log("[7] seed 幂等（不在本脚本，另行验证）");

console.log(`\n=== 边界测试：${pass} 通过 / ${fail} 失败 ===`);
process.exitCode = fail > 0 ? 1 : 0;
await prisma.$disconnect();
