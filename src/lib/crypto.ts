"use server";

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Symmetric encryption for broker API credentials at rest.
 *
 * The threat we're defending against: anyone with admin access to the
 * Firebase project (e.g. the app owner) can otherwise read friends' raw
 * Trading212 API keys straight out of Firestore via the console. Encrypting
 * with a master key that lives only in the server env (Vercel) means a
 * Firestore dump alone isn't enough.
 *
 * Algorithm: AES-256-GCM. 12-byte random IV per encryption, appended with
 * the 16-byte auth tag and the ciphertext, all hex-encoded, dot-separated.
 * Distinguishable from a legacy plaintext T212 key (which is `key:secret`
 * and always contains a colon). Callers use that heuristic to opportunistic-
 * migrate legacy records on next sync.
 *
 * Master key: `T212_ENCRYPTION_KEY`, base64-encoded 32 bytes. Generate with
 * `openssl rand -base64 32`. **If this key is ever lost or rotated without
 * re-encrypting, every stored credential becomes unrecoverable** and users
 * must reconnect.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function getKey(): Buffer {
  const raw = process.env.T212_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "T212_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and add it to your env.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `T212_ENCRYPTION_KEY must decode to 32 bytes; got ${key.length}.`,
    );
  }
  return key;
}

/** Encrypt a UTF-8 string. Returns `iv.tag.ciphertext`, all hex. */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${ct.toString("hex")}`;
}

/** Decrypt a blob produced by `encryptSecret`. Throws if tampered or wrong key. */
export async function decryptSecret(blob: string): Promise<string> {
  const key = getKey();
  const parts = blob.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext");
  }
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
