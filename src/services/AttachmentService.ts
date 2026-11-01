import crypto from "crypto";
import { Op } from "sequelize";
import { MAX_ATTACHMENT_BYTES, PLANS } from "../common/plans";
import Attachment from "../models/Attachment";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import CollectionService from "./CollectionService";
import EntitlementService, { PlanLimitError } from "./EntitlementService";
import NoteService from "./NoteService";
import StorageService from "./StorageService";

/**
 * Encrypted file attachments (plans/vault-features.md, phase C).
 *
 * The browser encrypts each file with its own key in 1 MiB chunks, and wraps that key with
 * the item's key, so everyone who can open the item can open its files (shares,
 * collections, groups), with nothing extra to hand over. Here: who may add, see and delete
 * them, how much storage they use, and short-lived links to the stored bytes.
 *
 * Storage counts against the item's owner, or against the company for an item in a
 * company collection (per member, pooled).
 */

const MIB = 1024 * 1024;
/** Per chunk: a 12-byte IV and a 16-byte tag. */
const CHUNK_OVERHEAD = 28;
const MAX_STORED = MAX_ATTACHMENT_BYTES + Math.ceil(MAX_ATTACHMENT_BYTES / MIB) * CHUNK_OVERHEAD;
const MAX_PER_ITEM = 50;
const ENCRYPTED = /^e2e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20,2000}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export class AttachmentError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const view = (row: Attachment) => ({
  id: row.id,
  size: row.size,
  encMeta: row.encMeta,
  wrappedKey: row.wrappedKey,
  uploadedBy: row.uploadedBy ?? null,
  createdAt: row.createdAt.toISOString(),
});

class AttachmentService {
  /** The item's files, for anyone who can open the item. */
  async list(noteId: number, userId: number) {
    await this.access(noteId, userId, false);
    const rows = await Attachment.findAll({ where: { noteId, status: "ready" }, order: [["createdAt", "ASC"]] });
    return rows.map(view);
  }

  /** Make room for a file: checks access, size and storage, and returns where to upload it. */
  async reserve(noteId: number, userId: number, size: unknown) {
    if (!StorageService.available()) throw new AttachmentError("File storage isn't set up yet.", 503);
    const { note } = await this.access(noteId, userId, true);
    if (!note.e2e) throw new AttachmentError("Files need end-to-end encryption. Open your vault once so this item is encrypted.", 409);
    const bytes = Number(size);
    if (!Number.isInteger(bytes) || bytes <= 0) throw new AttachmentError("Bad file size.");
    if (bytes > MAX_STORED) throw new AttachmentError(`Files can be up to ${MAX_ATTACHMENT_BYTES / MIB} MB.`, 413);
    if ((await Attachment.count({ where: { noteId } })) >= MAX_PER_ITEM) {
      throw new AttachmentError(`An item can have up to ${MAX_PER_ITEM} files.`, 409);
    }

    const pool = await this.poolFor(noteId, note.userId);
    const { used, limit } = await this.usage(pool);
    if (used + bytes > limit) {
      throw new PlanLimitError(
        pool.companyId
          ? "The company's file storage is full. Delete some files to add more."
          : limit < PLANS.premium.limits.storageBytes
            ? "The Free plan includes 50 MB of files. Upgrade to Premium for 1 GB."
            : "Your file storage is full. Delete some files to add more.",
        "storageBytes"
      );
    }

    // The files folder keeps a reserve free, so the server's disk never fills up.
    if (!(await StorageService.hasRoom(bytes))) {
      console.error("Attachment refused: the files folder is low on space");
      throw new AttachmentError("The server is out of space for files right now. Try again later.", 507);
    }

    const id = crypto.randomBytes(16).toString("base64url");
    await Attachment.create({
      id,
      noteId,
      uploadedBy: userId,
      ownerUserId: pool.companyId ? null : pool.userId,
      companyId: pool.companyId,
      size: bytes,
    });
    return { id, upload: await StorageService.uploadUrl(id, bytes) };
  }

  /** The upload finished: check the stored size, and keep the file's wrapped key and name. */
  async complete(id: string, userId: number, input: { encMeta?: unknown; wrappedKey?: unknown }) {
    const row = await Attachment.findOne({ where: { id, uploadedBy: userId, status: "uploading" } });
    if (!row || !row.noteId) throw new AttachmentError("Upload not found", 404);
    await this.access(row.noteId, userId, true);
    const encMeta = String(input.encMeta || "");
    const wrappedKey = String(input.wrappedKey || "");
    if (!ENCRYPTED.test(encMeta) || !ENCRYPTED.test(wrappedKey)) throw new AttachmentError("Bad file details.");
    const stored = await StorageService.size(id);
    if (stored !== row.size) {
      throw new AttachmentError(stored === null ? "The file didn't arrive. Try again." : "The file arrived incomplete. Try again.", 409);
    }
    await row.update({ status: "ready", encMeta, wrappedKey });
    return { file: view(row), noteId: row.noteId };
  }

  async download(id: string, userId: number) {
    const row = await Attachment.findOne({ where: { id, status: "ready" } });
    if (!row || !row.noteId) throw new AttachmentError("File not found", 404);
    await this.access(row.noteId, userId, false);
    return { noteId: row.noteId, download: await StorageService.downloadUrl(id) };
  }

  async remove(id: string, userId: number) {
    const row = await Attachment.findByPk(id);
    if (!row || !row.noteId) throw new AttachmentError("File not found", 404);
    await this.access(row.noteId, userId, true);
    await StorageService.remove(id);
    await row.destroy();
    return { noteId: row.noteId };
  }

  /** This person's own storage (Billing). */
  async personalUsage(userId: number) {
    return this.usage({ userId, companyId: null });
  }

  /** Daily: files of items deleted for good, and uploads that never finished. */
  async cleanup() {
    const rows = await Attachment.findAll({
      where: {
        [Op.or]: [{ noteId: null }, { status: "uploading", createdAt: { [Op.lt]: new Date(Date.now() - DAY_MS) } }],
      },
      limit: 500,
    });
    let removed = 0;
    for (const row of rows) {
      try {
        await StorageService.remove(row.id);
        await row.destroy();
        removed += 1;
      } catch {
        // Tried again tomorrow.
      }
    }
    return { removed };
  }

  // ---------------------------------------------------------------- helpers

  private async access(noteId: number, userId: number, edit: boolean) {
    const access = await NoteService.getNoteAccess(noteId, userId);
    if (!access) throw new AttachmentError("Item not found", 404);
    if (edit && access.permission === "view") throw new AttachmentError("You can only view this item.", 403);
    return access;
  }

  /** Whose storage a file on this item uses: the company's for company items, else the item owner's. */
  private async poolFor(noteId: number, ownerId: number) {
    const linked = (await CollectionService.collectionsByNoteId([noteId])).get(noteId) || [];
    const companyId = linked.find((collection) => collection.companyId)?.companyId ?? null;
    return { userId: ownerId, companyId };
  }

  private async usage(pool: { userId: number; companyId: number | null }) {
    if (pool.companyId) {
      const company = await Company.findByPk(pool.companyId, { attributes: ["id", "status"] });
      const members = company?.status === "active"
        ? await CompanyMember.count({ where: { companyId: pool.companyId, status: "active" } })
        : 0;
      const used = Number((await Attachment.sum("size", { where: { companyId: pool.companyId } })) || 0);
      return { used, limit: PLANS.team.limits.storageBytes * members };
    }
    const { limits } = await EntitlementService.forUser(pool.userId);
    const used = Number((await Attachment.sum("size", { where: { ownerUserId: pool.userId, companyId: null } })) || 0);
    return { used, limit: limits.storageBytes };
  }
}

export default new AttachmentService();
