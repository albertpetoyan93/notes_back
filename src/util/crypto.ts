import crypto from "crypto";

const key = Buffer.alloc(16);
const password = Buffer.from("d98z0k30sl3hds");
password.copy(key);
const iv = Buffer.from("1357924688642975", "utf8");

export function encrypt(plainText: string) {
  try {
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    let encrypted = cipher.update(plainText, "utf8", "base64");
    encrypted += cipher.final("base64");

    return encrypted;
  } catch (error) {
    console.log(error);
  }
}
export function decrypt(encryptedBase64: string) {
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    let decrypted = decipher.update(encryptedBase64, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    // console.error("❌ Decryption failed:");
    // console.error("Encrypted input:", encryptedBase64);
    // console.error("Error:", error.message);
    throw error;
  }
}

export function md5Hash(text: string): string {
  return crypto.createHash("md5").update(text).digest("hex");
}
export function verifyMd5(originalText: string, hashedText: string): boolean {
  const hash = md5Hash(originalText);
  return hash === hashedText;
}
