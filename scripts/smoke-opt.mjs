/**
 * 玩法优化冒烟：超时判错 / 真实连击 / 线索递进扣分 / 跨局防重复
 * 用法：先启动服务（npm run dev），再 node scripts/smoke-opt.mjs
 */

import crypto from "node:crypto";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

/* ---------- 加密客户端（与 secureFetch 等价） ---------- */

let sessionId, aesKey, wrappedKey, keySent = false;
const b64 = (b) => Buffer.from(b).toString("base64");

async function ensure() {
  if (sessionId) return;
  const { sessionId: sid, publicKey } = await (await fetch(`${BASE}/api/crypto/key`)).json();
  sessionId = sid;
  aesKey = crypto.randomBytes(32);
  const pub = crypto.createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  wrappedKey = crypto
    .publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey)
    .toString("base64");
}

function enc(payload) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return {
    v: 1,
    sessionId,
    key: keySent ? null : wrappedKey,
    iv: b64(iv),
    tag: b64(c.getAuthTag()),
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
    data: b64(ct),
  };
}

function dec(e) {
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(e.iv, "base64"));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString());
}

async function post(path, payload) {
  await ensure();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(enc(payload)),
  });
  keySent = true;
  const j = await res.json();
  return { status: res.status, body: res.ok ? dec(j) : j };
}

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
function note(name) { skip++; console.log(`  ~ ${name}（跳过：概率样本不足）`); }

/* ---------- 1. 超时判错（诗词） ---------- */
console.log("[1] 超时未答按错处理");
{
  const s = await post("/api/games/poetry/session", { stage: "PRIMARY", count: 5 });
  const gid = s.body.gameSessionId;
  check("开局成功", !!gid, JSON.stringify(s.body).slice(0, 120));

  const r0 = await post("/api/games/poetry/answer", {
    gameSessionId: gid, roundIndex: 0, timeout: true, timeMs: 15000,
  });
  check("超时提交 200", r0.status === 200, `实际 ${r0.status} ${JSON.stringify(r0.body).slice(0, 100)}`);
  check("timeout=true 回传", r0.body.timeout === true);
  check("超时判定答错", r0.body.correct === false);
  check("超时 0 分", r0.body.gained === 0 && r0.body.multiplier === 0, `实际 gained=${r0.body.gained}`);

  // 同一轮再次提交（含正常选项）仍被 409 拦截
  const dup = await post("/api/games/poetry/answer", {
    gameSessionId: gid, roundIndex: 0, choice: 0, timeMs: 100,
  });
  check("超时后重复提交 → 409", dup.status === 409, `实际 ${dup.status}`);

  // 上题超时后，第 2 题即便答对，倍率也只能是 1.2（旧 bug 会错算成 1.4）
  const r1 = await post("/api/games/poetry/answer", {
    gameSessionId: gid, roundIndex: 1, choice: 0, timeMs: 1000,
  });
  check("第 2 题倍率 ∈ {0, 1.2}（真实连击）",
    r1.status === 200 && (r1.body.multiplier === 0 || Number(r1.body.multiplier.toFixed(1)) === 1.2),
    `实际 multiplier=${r1.body.multiplier}`);

  // 无 choice 且无 timeout → 400
  const noChoice = await post("/api/games/poetry/answer", {
    gameSessionId: gid, roundIndex: 2, timeMs: 100,
  });
  check("缺 choice 且无 timeout → 400", noChoice.status === 400, `实际 ${noChoice.status}`);
}

/* ---------- 2. 物品：线索递进扣分 / 揭示数夹取 / 谜语超时 ---------- */
console.log("[2] 物品线索递进与谜语超时");
{
  const samples = { base: [], more: [] };
  let riddleTimeoutOk = null;
  for (let i = 0; i < 30; i++) {
    const s = await post("/api/games/object/session", { difficulty: "EASY", count: 5 });
    const r0 = s.body.rounds?.[0];
    if (!r0) break;
    if (r0.type === "GUESS_FROM_CLUES") {
      const useMore = i % 2 === 0;
      const revealedClues = useMore ? Math.min(999, r0.clues.length) : 1;
      const r = await post("/api/games/object/answer", {
        gameSessionId: s.body.gameSessionId, roundIndex: 0,
        choice: i % 4, timeMs: 1000, revealedClues,
      });
      if (r.body.correct) {
        (useMore ? samples.more : samples.base).push(r.body.gained);
      }
      check("答对得分不低于保底 20", r.body.gained === 0 || r.body.gained >= 20, `实际 ${r.body.gained}`);
    } else if (r0.type === "GUESS_FROM_RIDDLE" && riddleTimeoutOk === null) {
      const r = await post("/api/games/object/answer", {
        gameSessionId: s.body.gameSessionId, roundIndex: 0, timeout: true, timeMs: 20000,
      });
      riddleTimeoutOk = r.status === 200 && r.body.correct === false && r.body.timeout === true;
    }
  }
  if (samples.base.length > 0 && samples.more.length > 0) {
    const baseMin = Math.min(...samples.base);
    const moreMax = Math.max(...samples.more);
    // 基准答对 ≥100（1.2x=120），揭示全部线索后应至少少 30 或触底 20
    check("线索扣分生效（多揭示得分更低/保底 20）",
      baseMin >= 100 && (moreMax <= baseMin - 30 || moreMax === 20),
      `base=${samples.base.join(",")} more=${samples.more.join(",")}`);
  } else {
    note(`线索扣分差值（答对样本不足 base=${samples.base.length} more=${samples.more.length}）`);
  }
  if (riddleTimeoutOk !== null) check("谜语题超时判错 200", riddleTimeoutOk);
  else note("谜语题超时（30 局未遇到谜语首题）");
}

/* ---------- 3. 跨局防重复（同玩家连开两局） ---------- */
console.log("[3] 跨局优先出没见过的题");
{
  const p = await post("/api/player", {});
  const playerId = p.body.id;
  check("玩家创建成功", !!playerId, JSON.stringify(p.body).slice(0, 100));

  const s1 = await post("/api/games/poetry/session", { stage: "PRIMARY", count: 10, playerId });
  const s2 = await post("/api/games/poetry/session", { stage: "PRIMARY", count: 10, playerId });
  const p1 = s1.body.rounds.map((r) => r.prompt);
  const p2 = s2.body.rounds.map((r) => r.prompt);
  const overlap = p2.filter((x) => p1.includes(x)).length;
  check("两局题面几乎不重合（≤2/10）", overlap <= 2, `重合 ${overlap} 题`);
  check("第二局仍满 10 题", s2.body.rounds.length === 10, `实际 ${s2.body.rounds.length}`);

  // 连开第 3、4 局（seen 累积）不应失败
  const s3 = await post("/api/games/poetry/session", { stage: "PRIMARY", count: 10, playerId });
  const s4 = await post("/api/games/poetry/session", { stage: "PRIMARY", count: 10, playerId });
  check("seen 累积后连续开局正常", s3.body.rounds?.length > 0 && s4.body.rounds?.length > 0);

  // 视图不下发素材 key / 答案
  const leaked = JSON.stringify(s2.body.rounds[0]).includes("sourceKey");
  check("sourceKey 不下发", !leaked);
}

console.log(`\n=== 玩法优化冒烟：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 ===`);
process.exitCode = fail > 0 ? 1 : 0;
