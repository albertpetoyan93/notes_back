import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import NoteVersion from "../models/NoteVersion";
import User from "../models/User";
import { decryptContent, encryptContent, isDecryptionFailure } from "../util/encryption";

const KEEP_VERSIONS = 50;
const KEEP_DAYS = 365;

/** An item's saved state: what a version holds. */
export interface ItemState {
  title: string;
  category: string;
  tags: string[];
  content: any;
}

// Saved passkeys (private keys) are never copied into history. Restoring
// keeps the item's current passkeys (see util/passkeyContent mergeOnUpdate).
function withoutPasskeys(content: any) {
  if (!content || typeof content !== "object") return content ?? {};
  const { passkeys: _passkeys, ...rest } = content;
  return rest;
}

const fieldsOf = (content: any): { label: string; value: string }[] =>
  content && typeof content === "object" && Array.isArray(content.customFields)
    ? content.customFields.map((field: any) => ({
        label: String(field?.label ?? ""),
        value: String(field?.value ?? ""),
      }))
    : [];

const bodyOf = (content: any) =>
  typeof content === "string" ? content : String(content?.mainContent ?? "");

/** What changed between two states, by name only: never the values. */
export function describeChanges(before: ItemState, after: ItemState): string[] {
  const changes: string[] = [];
  if (before.title !== after.title) changes.push("Name");
  if (before.category !== after.category) changes.push("Category");
  if (JSON.stringify(before.tags || []) !== JSON.stringify(after.tags || [])) changes.push("Tags");
  if (bodyOf(before.content) !== bodyOf(after.content)) changes.push("Notes");

  const old = fieldsOf(before.content);
  const next = fieldsOf(after.content);
  const labels = [...new Set([...old, ...next].map((field) => field.label))];
  for (const label of labels) {
    const a = old.filter((field) => field.label === label).map((field) => field.value);
    const b = next.filter((field) => field.label === label).map((field) => field.value);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(label || "A field");
  }
  return [...new Set(changes)];
}

class VersionService {
  /**
   * Keep the state an item was just saved in. `before` is its state before
   * this save: it seeds the history of items made before history existed.
   */
  async afterSave(
    noteId: number,
    after: ItemState,
    changedBy: number,
    before?: ItemState & { savedAt?: Date }
  ) {
    const changes = before ? describeChanges(before, after) : ["Created"];
    if (!changes.length) return;

    if (before && !isDecryptionFailure(before.content)) {
      const existing = await NoteVersion.count({ where: { noteId } });
      if (!existing) {
        await this.store(noteId, before, ["Earlier version"], null, before.savedAt);
      }
    }
    await this.store(noteId, after, changes, changedBy);
    await this.prune(noteId);
  }

  private async store(
    noteId: number,
    state: ItemState,
    changes: string[],
    changedBy: number | null,
    createdAt?: Date
  ) {
    await NoteVersion.create({
      noteId,
      title: String(state.title || "").slice(0, 255),
      category: String(state.category || "note").slice(0, 50),
      tags: Array.isArray(state.tags) ? state.tags : [],
      content: encryptContent(JSON.stringify(withoutPasskeys(state.content))),
      changes,
      changedBy,
      ...(createdAt ? { createdAt } : {}),
    });
  }

  /**
   * A version of an end-to-end item: the browser sealed the whole state (and
   * what changed) with the item key, so the server stores it as it is.
   */
  async storeSealed(noteId: number, encData: string, changedBy: number) {
    await NoteVersion.create({
      noteId,
      title: "",
      category: "note",
      tags: [],
      content: encData,
      changes: [],
      changedBy,
      e2e: true,
    });
    await this.prune(noteId);
  }

  /** The newest KEEP_VERSIONS, and nothing older than a year except the newest. */
  private async prune(noteId: number) {
    await sequelize.query(
      `DELETE FROM "note_versions"
       WHERE "noteId" = :noteId
         AND id NOT IN (
           SELECT id FROM "note_versions" WHERE "noteId" = :noteId
           ORDER BY "createdAt" DESC, id DESC LIMIT :keep
         )`,
      { replacements: { noteId, keep: KEEP_VERSIONS } }
    );
    const newest = await NoteVersion.findOne({
      where: { noteId },
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      attributes: ["id"],
    });
    if (newest) {
      await NoteVersion.destroy({
        where: {
          noteId,
          id: { [Op.ne]: newest.id },
          createdAt: { [Op.lt]: new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000) },
        },
      });
    }
  }

  /** Newest first, without content. */
  async list(noteId: number) {
    const rows = await NoteVersion.findAll({
      where: { noteId },
      attributes: ["id", "createdAt", "changes", "changedBy", "title", "e2e", "content"],
      include: [{ model: User, as: "author", attributes: ["id", "username", "fullName"] }],
      order: [["createdAt", "DESC"], ["id", "DESC"]],
    });
    return rows.map((row, index) => {
      const author = row.get("author") as User | null;
      return {
        id: row.id,
        createdAt: row.createdAt,
        title: row.title,
        changes: row.changes || [],
        current: index === 0,
        changedBy: author ? { id: author.id, name: author.fullName || author.username } : null,
        // Sealed: the browser opens it for the name and the changes.
        ...(row.e2e ? { e2e: true, encData: row.content } : {}),
      };
    });
  }

  /** One version with its content decrypted, or null. */
  async get(noteId: number, versionId: number) {
    const row = await NoteVersion.findOne({
      where: { id: versionId, noteId },
      include: [{ model: User, as: "author", attributes: ["id", "username", "fullName"] }],
    });
    if (!row) return null;
    const author = row.get("author") as User | null;
    const changedBy = author ? { id: author.id, name: author.fullName || author.username } : null;
    if (row.e2e) {
      return { id: row.id, createdAt: row.createdAt, e2e: true, encData: row.content, changedBy };
    }
    let content: any = decryptContent(row.content);
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        /* Plain text content stays a string. */
      }
    }
    return {
      id: row.id,
      createdAt: row.createdAt,
      title: row.title,
      category: row.category,
      tags: row.tags || [],
      content,
      changes: row.changes || [],
      changedBy,
    };
  }
}

export default new VersionService();
