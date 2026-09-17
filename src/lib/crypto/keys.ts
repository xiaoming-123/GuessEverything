/**
 * RSA 密钥管理（服务端）
 *
 * - 生产：从环境变量 CRYPTO_RSA_PRIVATE_KEY（PKCS#8 PEM）加载
 * - 开发：未配置时自动生成内存密钥对（进程重启失效，仅限本地）
 */

import crypto from "node:crypto";
import { CryptoError } from "./protocol";

const ENV_KEY_NAME = "CRYPTO_RSA_PRIVATE_KEY";

interface KeyCache {
  privateKey: crypto.KeyObject;
  publicKeyBase64: string;
}

// 挂在 globalThis 上避免 dev HMR 重复生成
const globalForKeys = globalThis as unknown as { __mysteryBoxKeyCache?: KeyCache };

function generateKeyPair(): KeyCache {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKey,
    publicKeyBase64: derToBase64(publicPem),
  };
}

/** PEM(SPKI) → base64(DER)，供浏览器 WebCrypto 导入 */
function derToBase64(publicKeyPem: string): string {
  return Buffer.from(
    publicKeyPem
      .replace(/-----BEGIN PUBLIC KEY-----/, "")
      .replace(/-----END PUBLIC KEY-----/, "")
      .replace(/\s+/g, ""),
    "base64",
  ).toString("base64");
}

function loadKeyPair(): KeyCache {
  const envKey = process.env[ENV_KEY_NAME];
  if (envKey) {
    try {
      const privateKey = crypto.createPrivateKey({
        key: envKey.replace(/\\n/g, "\n"),
        format: "pem",
        type: "pkcs8",
      });
      const publicKey = crypto.createPublicKey(privateKey);
      const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
      return { privateKey, publicKeyBase64: derToBase64(pem) };
    } catch {
      throw new CryptoError("CRYPTO_FAILED", "CRYPTO_RSA_PRIVATE_KEY 配置非法");
    }
  }
  return generateKeyPair();
}

/** 获取服务端密钥（单例） */
export function getServerKeys(): KeyCache {
  globalForKeys.__mysteryBoxKeyCache ??= loadKeyPair();
  return globalForKeys.__mysteryBoxKeyCache;
}
