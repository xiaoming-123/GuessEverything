/**
 * API 延迟测量（需 dev server）：node scripts/time-api.mjs
 */
import crypto from "node:crypto";

const BASE = "http://localhost:3000";
let sessionId, aesKey, wrappedKey, keySent = false;
const b64 = (b) => Buffer.from(b).toString("base64");

async function ensure() {
  if (sessionId) return;
  const t0 = Date.now();
  const { sessionId: sid, publicKey } = await (await fetch(`${BASE}/api/crypto/key`)).json();
  console.log(`key-exchange: ${Date.now() - t0}ms`);
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

async function post(path, payload) {
  await ensure();
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(enc(payload)) });
  keySent = true;
  const j = await res.json();
  const ms = Date.now() - t0;
  return { ms, body: res.ok ? dec(j) : j };
}

const p = await post("/api/player", {});
console.log(`player(冷): ${p.ms}ms`);
const p2 = await post("/api/player", { playerId: p.body.id });
console.log(`player(热): ${p2.ms}ms`);

for (let i = 0; i < 3; i++) {
  const s = await post("/api/games/poetry/session", { stage: "PRIMARY", count: 10, playerId: p.body.id });
  console.log(`session#${i}: ${s.ms}ms (rounds=${s.body.rounds?.length})`);
  const a = await post("/api/games/poetry/answer", { gameSessionId: s.body.gameSessionId, roundIndex: 0, choice: 0, timeMs: 1000 });
  console.log(`answer#${i}: ${a.ms}ms`);
}
