import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import EnvVars from "../common/EnvVars";

/**
 * Where attachment files are kept (plans/vault-features.md, phase C). The only code that
 * talks to storage. It only ever holds ciphertext: files are encrypted in the browser.
 *
 * Two drivers, STORAGE_DRIVER (default: "s3" when STORAGE_BUCKET is set, else "local"):
 * - "local": files in a folder on this server, served by this API at /api/files with
 *   short-lived signed URLs. In production it must be chosen explicitly
 *   (STORAGE_DRIVER=local) with an absolute STORAGE_LOCAL_DIR outside the app folder,
 *   ideally on its own disk; uploads stop while that disk has less than
 *   STORAGE_MIN_FREE_GB free (default 5), so files never fill it up. In development the
 *   folder defaults to ./storage.
 * - "s3": any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, MinIO).
 *   STORAGE_ENDPOINT, STORAGE_REGION (R2: "auto"), STORAGE_BUCKET, STORAGE_KEY_ID,
 *   STORAGE_SECRET. The browser uploads and downloads directly with short-lived signed
 *   URLs; the bucket needs CORS allowing PUT and GET from the app's origin.
 * Moving from local to a bucket later: copy the folder's files into the bucket under the
 * same names (each file's name is its key), then switch the variables.
 */

const URL_SECONDS = 10 * 60;

export interface SignedUrl {
  url: string;
  /** Headers the browser must send with it. */
  headers: Record<string, string>;
}

type Op = "put" | "get";

const env = (name: string) => (process.env[name] || "").trim();

class StorageService {
  private s3: S3Client | null = null;

  driver(): "s3" | "local" {
    const chosen = env("STORAGE_DRIVER");
    if (chosen === "s3" || chosen === "local") return chosen;
    return env("STORAGE_BUCKET") ? "s3" : "local";
  }

  /** Whether files can be stored at all. Production never falls back to a folder by accident. */
  available() {
    if (this.driver() === "s3") return !!env("STORAGE_BUCKET");
    if (EnvVars.NodeEnv !== "production") return true;
    return env("STORAGE_DRIVER") === "local" && path.isAbsolute(env("STORAGE_LOCAL_DIR"));
  }

  /** Room for this many more bytes, keeping the reserve free (local folder only). */
  async hasRoom(bytes: number) {
    if (this.driver() === "s3") return true;
    const root = this.localRoot();
    await fs.mkdir(root, { recursive: true });
    const stats = await fs.statfs(root);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const reserve = (Number(env("STORAGE_MIN_FREE_GB")) || 5) * 1024 ** 3;
    return free - bytes >= reserve;
  }

  async uploadUrl(key: string, size: number): Promise<SignedUrl> {
    const headers = { "Content-Type": "application/octet-stream" };
    if (this.driver() === "local") return { url: this.localUrl("put", key, size), headers };
    const url = await getSignedUrl(
      this.client(),
      new PutObjectCommand({ Bucket: env("STORAGE_BUCKET"), Key: key, ContentType: headers["Content-Type"], ContentLength: size }),
      { expiresIn: URL_SECONDS }
    );
    return { url, headers };
  }

  async downloadUrl(key: string): Promise<SignedUrl> {
    if (this.driver() === "local") return { url: this.localUrl("get", key), headers: {} };
    const url = await getSignedUrl(this.client(), new GetObjectCommand({ Bucket: env("STORAGE_BUCKET"), Key: key }), {
      expiresIn: URL_SECONDS,
    });
    return { url, headers: {} };
  }

  /** The stored size, or null if nothing is there. */
  async size(key: string): Promise<number | null> {
    if (this.driver() === "local") {
      try {
        return (await fs.stat(this.localPath(key))).size;
      } catch {
        return null;
      }
    }
    try {
      const head = await this.client().send(new HeadObjectCommand({ Bucket: env("STORAGE_BUCKET"), Key: key }));
      return Number(head.ContentLength ?? 0);
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") return null;
      throw error;
    }
  }

  async remove(key: string) {
    if (this.driver() === "local") {
      await fs.rm(this.localPath(key), { force: true });
      return;
    }
    await this.client().send(new DeleteObjectCommand({ Bucket: env("STORAGE_BUCKET"), Key: key }));
  }

  // ---------------------------------------------------------------- local driver

  /** Checks a local signed URL; returns the file path it allows. */
  checkLocal(op: Op, key: string, query: { exp?: unknown; size?: unknown; sig?: unknown }) {
    const exp = Number(query.exp);
    const size = query.size === undefined ? "" : String(query.size);
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
    const expected = this.sign(op, key, exp, size);
    const given = Buffer.from(String(query.sig || ""));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return { file: this.localPath(key), size: size ? Number(size) : null };
  }

  /**
   * Stream an upload to its file: written to a temporary name and moved into place only
   * when exactly `size` bytes arrived, so a cut-off upload never looks finished.
   */
  async writeLocalStream(file: string, body: Readable, size: number | null) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.part`;
    let received = 0;
    const limit = size ?? Infinity;
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) body.destroy(new Error("too-large"));
    });
    try {
      await pipeline(body, createWriteStream(temp));
      if (size !== null && received !== size) throw new Error("wrong-size");
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  private localUrl(op: Op, key: string, size?: number) {
    const exp = Math.floor(Date.now() / 1000) + URL_SECONDS;
    const sizeText = size === undefined ? "" : String(size);
    const sig = this.sign(op, key, exp, sizeText).toString();
    const params = new URLSearchParams({ op, exp: String(exp), sig, ...(sizeText ? { size: sizeText } : {}) });
    // Relative: the app adds its API address.
    return `/api/files/${encodeURIComponent(key)}?${params}`;
  }

  private sign(op: Op, key: string, exp: number, size: string) {
    return Buffer.from(
      crypto
        .createHmac("sha256", `${EnvVars.Jwt.Secret}/2keevo-local-files`)
        .update(`${op}|${key}|${exp}|${size}`)
        .digest("base64url")
    );
  }

  private localPath(key: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new Error("Bad storage key");
    return path.join(this.localRoot(), key.slice(0, 2), key);
  }

  private localRoot() {
    return env("STORAGE_LOCAL_DIR") || path.join(process.cwd(), "storage");
  }

  private client() {
    if (!this.s3) {
      this.s3 = new S3Client({
        endpoint: env("STORAGE_ENDPOINT") || undefined,
        region: env("STORAGE_REGION") || "auto",
        credentials: { accessKeyId: env("STORAGE_KEY_ID"), secretAccessKey: env("STORAGE_SECRET") },
        // R2, B2 and MinIO address buckets by path.
        forcePathStyle: !!env("STORAGE_ENDPOINT"),
      });
    }
    return this.s3;
  }
}

export default new StorageService();
