import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import NoteVersion from "../models/NoteVersion";
import User from "../models/User";

const KEEP_VERSIONS = 50;
const KEEP_DAYS = 365;

class VersionService {
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

  /** One sealed version, or null. */
  async get(noteId: number, versionId: number) {
    const row = await NoteVersion.findOne({
      where: { id: versionId, noteId },
      include: [{ model: User, as: "author", attributes: ["id", "username", "fullName"] }],
    });
    if (!row) return null;
    const author = row.get("author") as User | null;
    const changedBy = author ? { id: author.id, name: author.fullName || author.username } : null;
    // Only sealed versions exist since stage 10.6; the browser opens them.
    if (!row.e2e) return null;
    return { id: row.id, createdAt: row.createdAt, e2e: true, encData: row.content, changedBy };
  }
}

export default new VersionService();
