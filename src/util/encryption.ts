import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || "your-32-character-secret-key!!"; // Must be 32 characters for aes-256
const KEY = crypto.scryptSync(ENCRYPTION_KEY, "salt", 32);

/**
 * Encrypt content using AES-256-GCM
 */
export function encrypt(text: string): string {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    // Return format: iv:authTag:encryptedData
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  } catch (error) {
    console.error("Encryption error:", error);
    throw new Error("Failed to encrypt data");
  }
}

/**
 * Decrypt content using AES-256-GCM
 */
export function decrypt(encryptedText: string): string {
  try {
    const parts = encryptedText.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted data format");
    }

    const [ivHex, authTagHex, encryptedData] = parts;

    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    console.error("Decryption error:", error);
    throw new Error("Failed to decrypt data");
  }
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

/**
 * Decrypt note content (handles both string and object)
 */
export function decryptContent(encryptedContent: any): any {
  try {
    if (typeof encryptedContent !== "string") {
      return encryptedContent;
    }

    // Check if it looks like encrypted data (has the format iv:authTag:data)
    if (!encryptedContent.includes(":")) {
      return encryptedContent;
    }

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
    return encryptedContent; // Return original if decryption fails
  }
}
