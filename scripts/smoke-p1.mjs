import crypto from "node:crypto";
const BASE = "http://localhost:3000";
let sessionId, aesKey, wrappedKey, keySent = false;
const b64 = (b) => Buffer.from(b).toString("base64");
async function ensure() {
  if (sessionId) return;
  const { sessionId: sid, publicKey } = await (await fetch(`${BASE}/api/crypto/key`)).json();
  sessionId = sid; aesKey = crypto.randomBytes(32);
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
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(enc(payload)) });
  keySent = true;
  const j = await res.json();
  if (!res.ok) throw new Error(`${path} [${res.status}] ${JSON.stringify(j)}`);
  return dec(j);
}
for (const [mode, body] of [["actor", { difficulty: "EASY", count: 5 }], ["object", { difficulty: "NORMAL", count: 5 }]]) {
  const s = await post(`/api/games/${mode}/session`, body);
  const leaked = s.rounds.some(r => "answerIndex" in r || "meta" in r);
  const a = await post(`/api/games/${mode}/answer`, { gameSessionId: s.gameSessionId, roundIndex: 0, choice: 0, timeMs: 2000 });
  console.log(`${mode}: 题数=${s.rounds.length} 无答案泄露=${!leaked} 首题="${s.rounds[0].prompt.slice(0, 30)}" 判题=${a.correct} 累计=${a.totalScore}`);
}
console.log("=== actor/object 冒烟通过 ===");
