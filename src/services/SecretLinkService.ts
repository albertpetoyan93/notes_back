import crypto from "crypto";
import { Op, QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import SecretLink from "../models/SecretLink";
import { decrypt, encrypt } from "../util/encryption";
import NoteService from "./NoteService";
import NotificationService from "./NotificationService";

export const EXPIRY_HOURS = [1, 24, 168];
const MAX_VIEWS = 10;
// 50 KB of secret, base64url-encoded with the GCM tag.
const MAX_CIPHERTEXT = 70_000;
const B64URL = /^[A-Za-z0-9_-]+$/;

export class SecretLinkError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const GONE = "This link no longer works. It was already opened, it expired, or the sender cancelled it.";

const newId = () => crypto.randomBytes(16).toString("base64url");

function status(link: SecretLink) {
  if (link.revokedAt) return "revoked";
  if (link.viewCount >= link.maxViews) return "used";
  if (new Date(link.expiresAt).getTime() <= Date.now() || !link.ciphertext) return "expired";
  return "active";
}

function readLabel(label: string | null) {
  if (!label) return "";
  try {
    return decrypt(label);
  } catch {
    return "";
  }
}

class SecretLinkService {
  async create(userId: number, input: any) {
    const ciphertext = String(input?.ciphertext || "");
    const iv = String(input?.iv || "");
    const salt = input?.salt ? String(input.salt) : null;
    const check = input?.check ? String(input.check) : null;
    if (!ciphertext || !B64URL.test(ciphertext) || ciphertext.length > MAX_CIPHERTEXT) {
      throw new SecretLinkError("The secret is missing or too large (50 KB at most).");
    }
    if (!B64URL.test(iv) || iv.length > 32) throw new SecretLinkError("Bad encryption data.");
    if (salt && (!B64URL.test(salt) || salt.length > 64)) throw new SecretLinkError("Bad passphrase data.");
    if (Boolean(salt) !== Boolean(check) || (check && (check.length > 200 || !/^[A-Za-z0-9_.-]+$/.test(check)))) {
      throw new SecretLinkError("Bad passphrase data.");
    }

    const hours = Number(input?.expiresInHours);
    if (!EXPIRY_HOURS.includes(hours)) throw new SecretLinkError("Choose 1 hour, 1 day or 7 days.");
    const maxViews = Number(input?.maxViews ?? 1);
    if (!Number.isInteger(maxViews) || maxViews < 1 || maxViews > MAX_VIEWS) {
      throw new SecretLinkError(`Allow between 1 and ${MAX_VIEWS} views.`);
    }

    let noteId: number | null = null;
    if (input?.noteId !== undefined && input?.noteId !== null) {
      noteId = Number(input.noteId);
      const access = await NoteService.getNoteAccess(noteId, userId);
      if (!access || (access.permission !== "owner" && access.permission !== "edit")) {
        throw new SecretLinkError("Only people who can edit an item can send it as a link.", 403);
      }
    }
    const label = String(input?.label || "").trim().slice(0, 100);

    await this.cleanUp();
    const link = await SecretLink.create({
      id: newId(),
      ciphertext,
      iv,
      salt,
      check,
      label: label ? encrypt(label) : null,
      maxViews,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
      createdBy: userId,
      noteId,
    });
    return { id: link.id, expiresAt: link.expiresAt, maxViews: link.maxViews, label };
  }

  /** The caller's links, newest first, never with their content. */
  async listMine(userId: number) {
    const links = await SecretLink.findAll({
      where: { createdBy: userId },
      order: [["createdAt", "DESC"]],
      limit: 100,
    });
    return links.map((link) => ({
      id: link.id,
      label: readLabel(link.label),
      noteId: link.noteId,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      maxViews: link.maxViews,
      viewCount: link.viewCount,
      openedAt: link.openedAt,
      passphrase: Boolean(link.salt),
      status: status(link),
    }));
  }

  async revoke(userId: number, id: string) {
    const [count] = await SecretLink.update(
      { ciphertext: null, revokedAt: new Date() },
      { where: { id, createdBy: userId, revokedAt: null } }
    );
    return count > 0;
  }

  /** What the public page needs before revealing. Doesn't use a view. */
  async peek(id: string) {
    const link = await SecretLink.findByPk(String(id).slice(0, 32));
    if (!link || status(link) !== "active") throw new SecretLinkError(GONE, 404);
    return {
      expiresAt: link.expiresAt,
      viewsLeft: link.maxViews - link.viewCount,
      passphrase: link.salt ? { salt: link.salt, check: link.check } : null,
    };
  }

  /**
   * Hand out the ciphertext and count the view, in one statement, so two
   * people can't both open a one-time link. The last view wipes it.
   */
  async open(id: string) {
    const rows = await sequelize.query<{
      ciphertext: string;
      iv: string;
      salt: string | null;
      viewCount: number;
      maxViews: number;
      createdBy: number;
      label: string | null;
      noteId: number | null;
    }>(
      `UPDATE "secret_links"
         SET "viewCount" = "viewCount" + 1, "openedAt" = NOW()
       WHERE id = :id AND "revokedAt" IS NULL AND ciphertext IS NOT NULL
         AND "viewCount" < "maxViews" AND "expiresAt" > NOW()
       RETURNING ciphertext, iv, salt, "viewCount", "maxViews", "createdBy", label, "noteId"`,
      { replacements: { id: String(id).slice(0, 32) }, type: QueryTypes.SELECT }
    );
    const row = rows[0];
    if (!row) throw new SecretLinkError(GONE, 404);
    if (row.viewCount >= row.maxViews) {
      await SecretLink.update({ ciphertext: null }, { where: { id } });
    }

    const label = readLabel(row.label);
    await NotificationService.create(
      row.createdBy,
      `Your one-time link${label ? ` "${label}"` : ""} was opened` +
        (row.maxViews > 1 ? ` (${row.viewCount} of ${row.maxViews} views used).` : "."),
      row.noteId ?? undefined
    ).catch(() => undefined);

    return {
      ciphertext: row.ciphertext,
      iv: row.iv,
      viewsLeft: row.maxViews - row.viewCount,
      creator: row.createdBy,
      label,
      noteId: row.noteId,
    };
  }

  // Expired links lose their content; long-gone ones are deleted.
  private async cleanUp() {
    await SecretLink.update(
      { ciphertext: null },
      { where: { expiresAt: { [Op.lt]: new Date() }, ciphertext: { [Op.ne]: null } } }
    );
    await SecretLink.destroy({
      where: { expiresAt: { [Op.lt]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    });
  }
}

export default new SecretLinkService();
