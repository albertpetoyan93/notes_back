import crypto from "crypto";

/**
 * AES-256-GCM with a random IV per value.
 *
 * Stored format: "v2:<keyId>:<iv>:<authTag>:<data>" (hex). Values written
 * before key ids existed are "<iv>:<authTag>:<data>"; they are read with
 * every known key (the auth tag tells which one is right).
 *
 * Keys come from the environment:
 * - ENCRYPTION_KEY: the key new values are written with. Required in production.
 * - ENCRYPTION_KEY_ID: its id, stored in each value (default "1").
 * - ENCRYPTION_OLD_KEYS: "id:secret,id:secret", keys still accepted for
 *   reading while `npm run reencrypt` moves data to the current key.
 */

const ALGORITHM = "aes-256-gcm";
// Only for local development, so a fresh checkout runs without setup.
const DEV_FALLBACK_KEY = "your-32-character-secret-key!!";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const V2_PATTERN =
  /^v2:([A-Za-z0-9_-]{1,32}):([0-9a-f]{32}):([0-9a-f]{32}):([0-9a-f]*)$/;
const LEGACY_PATTERN = /^([0-9a-f]{32}):([0-9a-f]{32}):([0-9a-f]*)$/;

interface Keyring {
  currentId: string;
  keys: Map<string, Buffer>;
}

let keyring: Keyring | null = null;

function deriveKey(secret: string) {
  // Same derivation as before key ids, so existing data stays readable.
  return crypto.scryptSync(secret, "salt", 32);
}

function loadKeyring(): Keyring {
  if (keyring) return keyring;

  const production = process.env.NODE_ENV === "production";
  let secret = process.env.ENCRYPTION_KEY || "";
  if (!secret || secret === DEV_FALLBACK_KEY) {
    if (production) {
      throw new Error(
        "ENCRYPTION_KEY is not set. Set it in env/production.env before starting the server."
      );
    }
    secret = DEV_FALLBACK_KEY;
  }

  const currentId = process.env.ENCRYPTION_KEY_ID || "1";
  if (!KEY_ID_PATTERN.test(currentId)) {
    throw new Error("ENCRYPTION_KEY_ID may only use letters, digits, - and _.");
  }

  const keys = new Map<string, Buffer>([[currentId, deriveKey(secret)]]);
  for (const entry of (process.env.ENCRYPTION_OLD_KEYS || "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    const id = trimmed.slice(0, at);
    const oldSecret = trimmed.slice(at + 1);
    if (at < 1 || !KEY_ID_PATTERN.test(id) || !oldSecret) {
      throw new Error('ENCRYPTION_OLD_KEYS must look like "id:secret,id:secret".');
    }
    if (id === currentId) {
      throw new Error(`ENCRYPTION_OLD_KEYS repeats the current key id "${id}".`);
    }
    keys.set(id, deriveKey(oldSecret));
  }

  keyring = { currentId, keys };
  return keyring;
}

/** Fail at startup, not on the first note, when the key setup is wrong. */
export function assertEncryptionReady() {
  loadKeyring();
}

function decryptWith(key: Buffer, ivHex: string, tagHex: string, data: string) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(data, "hex", "utf8") + decipher.final("utf8");
}

/** True when the value is in one of the formats encrypt() produces. */
export function isEncryptedValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (V2_PATTERN.test(value) || LEGACY_PATTERN.test(value))
  );
}

/** True when the value should be rewritten with the current key. */
export function needsReencrypt(value: string) {
  const match = V2_PATTERN.exec(value);
  return !match || match[1] !== loadKeyring().currentId;
}

/**
 * Encrypt content using AES-256-GCM
 */
export function encrypt(text: string): string {
  const { currentId, keys } = loadKeyring();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, keys.get(currentId)!, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();
  return `v2:${currentId}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt content using AES-256-GCM
 */
export function decrypt(encryptedText: string): string {
  const { currentId, keys } = loadKeyring();

  const v2 = V2_PATTERN.exec(encryptedText);
  if (v2) {
    const [, keyId, iv, tag, data] = v2;
    const key = keys.get(keyId);
    if (!key) {
      throw new Error(
        `Encrypted with key "${keyId}", which is not configured. Add it to ENCRYPTION_OLD_KEYS.`
      );
    }
    return decryptWith(key, iv, tag, data);
  }

  const legacy = LEGACY_PATTERN.exec(encryptedText);
  if (!legacy) {
    throw new Error("Invalid encrypted data format");
  }
  const [, iv, tag, data] = legacy;
  const ordered = [currentId, ...[...keys.keys()].filter((id) => id !== currentId)];
  for (const id of ordered) {
    try {
      return decryptWith(keys.get(id)!, iv, tag, data);
    } catch {
      // Wrong key: the auth tag does not match. Try the next one.
    }
  }
  throw new Error("Failed to decrypt data: no configured key matches.");
}

/**
 * Encrypt note content (handles both string and object)
 */
export function encryptContent(content: any): any {
  if (typeof content === "string") {
    return encrypt(content);
  }

  if (typeof content === "object" && content !== null) {
    // Encrypt the JSON stringified version
    return encrypt(JSON.stringify(content));
  }

  return content;
}

/** What a note's content becomes when it cannot be decrypted. */
export function isDecryptionFailure(content: unknown) {
  return Boolean(
    content &&
      typeof content === "object" &&
      (content as { decryptionFailed?: boolean }).decryptionFailed
  );
}

/**
 * Decrypt note content (handles both string and object)
 */
export function decryptContent(encryptedContent: any): any {
  // Content saved before it was encrypted is returned as it is.
  if (!isEncryptedValue(encryptedContent)) {
    return encryptedContent;
  }

  try {
    const decrypted = decrypt(encryptedContent);

    // Try to parse as JSON
    try {
      return JSON.parse(decrypted);
    } catch {
      // If not JSON, return as string
      return decrypted;
    }
  } catch (error) {
    console.error("Error decrypting content:", error);
    return {
      decryptionFailed: true,
      mainContent: "",
      customFields: [],
    };
  }
}
