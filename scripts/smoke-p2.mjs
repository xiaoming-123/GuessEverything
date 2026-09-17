/**
 * P2 端到端冒烟：玩家注册 → 闯关对局 → 进度归档 → 排行榜
 * 用法：node scripts/smoke-p2.mjs（需服务运行中）
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

async function securePost(path, payload, method = "POST") {
  await ensure();
  const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(enc(payload)) });
  keySent = true;
  const j = await res.json();
  return { status: res.status, body: res.ok ? dec(j) : j };
}

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

/* ---------- 1. 玩家注册与幂等 ---------- */
console.log("[1] 玩家注册");
const reg = await securePost("/api/player", {});
check("注册返回 playerId/nickname/avatar", Boolean(reg.body.id && reg.body.nickname && reg.body.avatar), JSON.stringify(reg.body).slice(0, 120));
const reg2 = await securePost("/api/player", { playerId: reg.body.id });
check("幂等注册返回同一玩家", reg2.body.id === reg.body.id);
check("档案含 progresses 数组", Array.isArray(reg2.body.progresses));
const rename = await securePost("/api/player", { playerId: reg.body.id, nickname: "测试猜谜人" }, "PATCH");
check("改昵称生效", rename.body.nickname === "测试猜谜玩家" ? false : rename.body.nickname === "测试猜谜人", rename.body.nickname);
const badName = await securePost("/api/player", { playerId: reg.body.id, nickname: "x" }, "PATCH");
check("过短昵称 → 400", badName.status === 400, `实际 ${badName.status}`);

const playerId = reg.body.id;

/* ---------- 2. 闯关对局（答对 60%+ 通关） ---------- */
console.log("[2] 诗词第 1 关对局");
const s = await securePost("/api/games/poetry/session", { stage: "PRIMARY", count: 5, playerId });
check("带 playerId 开局成功", Boolean(s.body.gameSessionId), JSON.stringify(s.body).slice(0, 120));
const gid = s.body.gameSessionId;

let lastJudge;
for (let i = 0; i < 5; i++) {
  const r = await securePost("/api/games/poetry/answer", { gameSessionId: gid, roundIndex: i, choice: 0, timeMs: 1500 });
  if (r.status !== 200) { check(`第 ${i} 题判题 200`, false, JSON.stringify(r.body).slice(0, 120)); break; }
  lastJudge = r.body;
}
check("全部判题 200", Boolean(lastJudge), "中途失败");

// 用 DB 里的正确答案重新打一局拿高分？——直接查 answerRecord 算正确率与 summary 对齐
check("结算含 summary", lastJudge && lastJudge.summary && typeof lastJudge.summary.accuracy === "number", JSON.stringify(lastJudge?.summary ?? {}));
const summary = lastJudge?.summary;
check("summary 字段完整", summary && [summary.correctCount, summary.totalRounds, summary.accuracy, summary.stars, summary.passed].every((v) => v !== undefined) && typeof summary.clearedNow === "boolean");

/* ---------- 3. 进度归档与解锁 ---------- */
console.log("[3] 进度与解锁");
const prog = await prisma.playerProgress.findUnique({
  where: { playerId_mode_stage: { playerId, mode: "POETRY", stage: "PRIMARY" } },
});
check("进度已归档", Boolean(prog), "PlayerProgress 无记录");
if (prog) {
  check("星级与正确率一致", prog.stars === summary.stars && prog.bestAccuracy === summary.accuracy, `db=${prog.stars}/${prog.bestAccuracy} summary=${summary.stars}/${summary.accuracy}`);
}
const profile = await securePost("/api/player", { playerId }, "PUT");
check("档案返回进度", (profile.body.progresses ?? []).some((p) => p.mode === "POETRY" && p.stage === "PRIMARY"));

// 高正确率通关后第 2 关应可开局（只有答对≥3 题才通关，可能未通关——条件判断）
if (prog && prog.stars >= 1) {
  const s2 = await securePost("/api/games/poetry/session", { stage: "JUNIOR", count: 5, playerId });
  check("通关后第 2 关可开局", s2.status === 200, `实际 ${s2.status}`);
} else {
  const s2 = await securePost("/api/games/poetry/session", { stage: "JUNIOR", count: 5, playerId });
  check("未通关时第 2 关被拒(403)", s2.status === 403, `实际 ${s2.status}`);
}

// 第三关永远应被拒（第二关从未通关）
const s3 = await securePost("/api/games/poetry/session", { stage: "SENIOR", count: 5, playerId });
check("第三关未解锁被拒(403)", s3.status === 403, `实际 ${s3.status}`);

/* ---------- 4. 排行榜 ---------- */
console.log("[4] 排行榜");
const lbRes = await fetch(`${BASE}/api/leaderboard?mode=POETRY&stage=PRIMARY&playerId=${playerId}`);
const lb = await lbRes.json();
check("排行榜 200 且结构完整", lbRes.ok && Array.isArray(lb.top) && ["mode", "stage"].every((k) => k in lb), JSON.stringify(lb).slice(0, 120));
check("上榜玩家出现", (lb.top ?? []).some((r) => r.playerId === playerId), JSON.stringify(lb.top ?? []).slice(0, 160));
check("我的排名匹配", lb.me && lb.me.playerId === playerId, JSON.stringify(lb.me ?? {}));
const lbBad = await fetch(`${BASE}/api/leaderboard?mode=NOPE`);
check("未知模式 → 400", lbBad.status === 400, `实际 ${lbBad.status}`);

console.log(`\n=== P2 冒烟：${pass} 通过 / ${fail} 失败 ===`);
process.exitCode = fail > 0 ? 1 : 0;
await prisma.$disconnect();
