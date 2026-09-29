import Note from "../models/Note";
import NoteShare, { SharePermission } from "../models/NoteShare";
import NoteFavorite from "../models/NoteFavorite";
import User from "../models/User";
import Collection from "../models/Collection";
import CollectionShare from "../models/CollectionShare";
import NotificationService from "./NotificationService";
import CollectionService from "./CollectionService";
import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface NoteFilters {
  category?: string;
  project?: string;
  tag?: string;
  search?: string;
  isFavorite?: boolean;
  sharedOnly?: boolean;
  trash?: boolean;
  collectionId?: number;
}

interface CreateNoteData {
  title: string;
  content: any;
  category: "note" | "password" | "login" | "command" | "ssh" | "db" | "other";
  project?: string;
  tags?: string[];
  isFavorite?: boolean;
  isEncrypted?: boolean;
  collectionId?: number | null;
}

interface UpdateNoteData {
  title?: string;
  content?: any;
  category?: "note" | "password" | "login" | "command" | "ssh" | "db" | "other";
  project?: string;
  tags?: string[];
  isFavorite?: boolean;
  isEncrypted?: boolean;
  collectionId?: number | null;
}

class NoteService {
  private activeShareFilter(where: Record<string, unknown>) {
    return {
      ...where,
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
    };
  }

  private collectionInclude() {
    return [
      {
        model: Collection,
        as: "collection",
        attributes: ["id", "name"],
        required: false,
      },
    ];
  }

  private async getAccessMaps(userId: number) {
    const noteShares = await NoteShare.findAll({
      where: this.activeShareFilter({ sharedWithUserId: userId }),
      attributes: ["noteId", "permission"],
    });
    const collectionShares = await CollectionShare.findAll({
      where: this.activeShareFilter({ sharedWithUserId: userId }),
      attributes: ["collectionId", "permission"],
    });

    const permissionByNoteId = new Map<number, SharePermission>();
    noteShares.forEach((share) => {
      permissionByNoteId.set(share.noteId, share.permission);
    });

    const permissionByCollectionId = new Map<number, SharePermission>();
    collectionShares.forEach((share) => {
      permissionByCollectionId.set(share.collectionId, share.permission);
    });

    const sharedCollectionIds = [...permissionByCollectionId.keys()];
    if (sharedCollectionIds.length) {
      const notes = await Note.findAll({
        where: { collectionId: { [Op.in]: sharedCollectionIds } },
        attributes: ["id", "collectionId"],
      });
      notes.forEach((note) => {
        const fromCollection = permissionByCollectionId.get(note.collectionId!);
        if (!fromCollection) return;
        const existing = permissionByNoteId.get(note.id);
        if (!existing || (existing === "view" && fromCollection === "edit")) {
          permissionByNoteId.set(note.id, fromCollection);
        }
      });
    }

    const ownedCollections = await Collection.findAll({
      where: { userId },
      attributes: ["id"],
    });
    const ownedCollectionIds = ownedCollections.map((collection) => collection.id);
    if (ownedCollectionIds.length) {
      const notes = await Note.findAll({
        where: {
          collectionId: { [Op.in]: ownedCollectionIds },
          userId: { [Op.ne]: userId },
        },
        attributes: ["id"],
      });
      notes.forEach((note) => {
        const existing = permissionByNoteId.get(note.id);
        if (!existing || existing === "view") {
          permissionByNoteId.set(note.id, "edit");
        }
      });
    }

    return {
      sharedNoteIds: [...permissionByNoteId.keys()],
      permissionByNoteId,
      ownedCollectionIds,
    };
  }

  private async getSharedNoteIds(userId: number) {
    const maps = await this.getAccessMaps(userId);
    return maps;
  }

  private async getFavoriteNoteIds(userId: number) {
    const rows = await NoteFavorite.findAll({
      where: { userId },
      attributes: ["noteId"],
    });
    return new Set(rows.map((row) => row.noteId));
  }

  private async setUserFavorite(userId: number, noteId: number, favorite: boolean) {
    const existing = await NoteFavorite.findOne({ where: { userId, noteId } });
    if (favorite && !existing) {
      await NoteFavorite.create({ userId, noteId });
    }
    if (!favorite && existing) {
      await existing.destroy();
    }
  }

  private annotateNote(
    note: Note,
    userId: number,
    permissionByNoteId: Map<number, SharePermission>,
    favoriteNoteIds?: Set<number>,
  ) {
    const isOwner = note.userId === userId;
    const permission = isOwner
      ? "owner"
      : permissionByNoteId.get(note.id) || "view";

    const json = note.toJSON() as any;
    return {
      ...json,
      isOwner,
      permission,
      isShared: !isOwner,
      isFavorite: favoriteNoteIds?.has(note.id) ?? false,
    };
  }

  /**
   * Get all notes for a user (owned + shared) with optional filters
   */
  async getNotes(userId: number, filters?: NoteFilters) {
    const { sharedNoteIds, permissionByNoteId, ownedCollectionIds } =
      await this.getAccessMaps(userId);

    let whereClause: any;

    if (filters?.collectionId) {
      const access = await CollectionService.getAccess(
        filters.collectionId,
        userId
      );
      if (!access) return [];
      whereClause = filters?.trash
        ? {
            userId,
            collectionId: filters.collectionId,
            deletedAt: { [Op.not]: null },
          }
        : { collectionId: filters.collectionId };
      if (filters?.sharedOnly) {
        whereClause.userId = { [Op.ne]: userId };
      }
    } else {
      whereClause = filters?.trash
        ? { userId, deletedAt: { [Op.not]: null } }
        : filters?.sharedOnly
          ? sharedNoteIds.length
            ? { id: { [Op.in]: sharedNoteIds } }
            : { id: { [Op.in]: [-1] } }
          : {
              [Op.or]: [
                { userId },
                ...(sharedNoteIds.length
                  ? [{ id: { [Op.in]: sharedNoteIds } }]
                  : []),
                ...(ownedCollectionIds.length
                  ? [{ collectionId: { [Op.in]: ownedCollectionIds } }]
                  : []),
              ],
            };
    }

    if (filters?.category && filters.category !== "all") {
      whereClause.category = filters.category;
    }

    if (filters?.project && filters.project !== "all") {
      whereClause.project = filters.project;
    }

    const andClauses = [...(whereClause[Op.and] || [])];

    if (filters?.isFavorite) {
      const favoriteIds = [...(await this.getFavoriteNoteIds(userId))];
      andClauses.push({
        id: { [Op.in]: favoriteIds.length ? favoriteIds : [-1] },
      });
    }

    if (filters?.tag && filters.tag !== "all") {
      andClauses.push(
        sequelize.literal(
          `"tags"::jsonb @> ${sequelize.escape(JSON.stringify([filters.tag]))}::jsonb`
        )
      );
    }

    if (filters?.search) {
      const searchTerm = `%${filters.search}%`;
      andClauses.push({
        [Op.or]: [
          { title: { [Op.iLike]: searchTerm } },
          { project: { [Op.iLike]: searchTerm } },
          { "$collection.name$": { [Op.iLike]: searchTerm } },
          sequelize.where(sequelize.cast(sequelize.col("tags"), "text"), {
            [Op.iLike]: searchTerm,
          }),
          sequelize.where(sequelize.cast(sequelize.col("content"), "text"), {
            [Op.iLike]: searchTerm,
          }),
        ],
      });
    }

    if (andClauses.length) {
      whereClause[Op.and] = andClauses;
    }

    const notes = await Note.findAll({
      where: whereClause,
      include: this.collectionInclude(),
      paranoid: !filters?.trash,
      order: [[filters?.trash ? "deletedAt" : "updatedAt", "DESC"]],
    });

    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);

    return notes.map((note) =>
      this.annotateNote(note, userId, permissionByNoteId, favoriteNoteIds),
    );
  }

  /**
   * Get a single note by ID if user owns it or it was shared with them
   */
  async getNoteById(noteId: number, userId: number) {
    const access = await this.getNoteAccess(noteId, userId);
    if (!access) return null;

    const { permissionByNoteId } = await this.getAccessMaps(userId);
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    return this.annotateNote(
      access.note,
      userId,
      permissionByNoteId,
      favoriteNoteIds
    );
  }

  /**
   * Backup of notes this user owns, with content already decrypted
   */
  async exportNotes(userId: number) {
    const notes = await Note.findAll({
      where: { userId },
      include: this.collectionInclude(),
      order: [["updatedAt", "DESC"]],
    });
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const exported = [];
    let skipped = 0;

    for (const note of notes) {
      const content = note.content as { decryptionFailed?: boolean };
      if (content?.decryptionFailed) {
        skipped += 1;
        continue;
      }
      exported.push({
        title: note.title,
        content: note.content,
        category: note.category,
        project: (note as any).collection?.name || note.project || null,
        collection: (note as any).collection?.name || null,
        tags: note.tags || [],
        isFavorite: favoriteNoteIds.has(note.id),
      });
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      skipped,
      notes: exported,
    };
  }

  /**
   * Create notes from a backup file. Shares are not copied.
   */
  async importNotes(userId: number, notes: any[]) {
    if (!Array.isArray(notes) || notes.length === 0) {
      throw Object.assign(new Error("Backup has no notes"), { status: 400 });
    }
    if (notes.length > 1000) {
      throw Object.assign(new Error("Backup is limited to 1000 notes"), {
        status: 400,
      });
    }

    const categories = [
      "note",
      "password",
      "login",
      "command",
      "ssh",
      "db",
      "other",
    ] as const;
    let imported = 0;
    const failed: { title: string; message: string }[] = [];

    for (const item of notes) {
      const title = String(item?.title || "").trim();
      try {
        if (!title) {
          throw new Error("Title is required");
        }
        if (!(categories as readonly string[]).includes(item?.category)) {
          throw new Error("Invalid category");
        }
        if (
          !item.content ||
          typeof item.content !== "object" ||
          item.content.decryptionFailed
        ) {
          throw new Error("Invalid content");
        }

        const tags = Array.isArray(item.tags)
          ? item.tags
              .map((tag: unknown) => String(tag).trim())
              .filter(Boolean)
              .slice(0, 20)
          : [];

        const collectionName = String(item.collection || item.project || "").trim();
        let collectionId: number | null = null;
        if (collectionName) {
          const [collection] = await Collection.findOrCreate({
            where: { userId, name: collectionName.slice(0, 100) },
            defaults: { userId, name: collectionName.slice(0, 100) },
          });
          collectionId = collection.id;
        }

        await this.createNote(userId, {
          title: title.slice(0, 255),
          content: item.content,
          category: item.category,
          collectionId,
          tags,
          isFavorite: Boolean(item.isFavorite),
        });
        imported += 1;
      } catch (error) {
        console.error("Error importing note:", error);
        failed.push({
          title: title || "Untitled",
          message: "Could not import this note",
        });
      }
    }

    return { imported, failed };
  }

  /**
   * Create a new note
   */
  async createNote(userId: number, data: CreateNoteData) {
    let collectionId: number | null = null;
    let project = data.project || undefined;
    if (data.collectionId) {
      const access = await CollectionService.assertCanAdd(data.collectionId, userId);
      collectionId = access.collection.id;
      project = access.collection.name;
    }

    const note = await Note.create({
      title: data.title,
      content: data.content,
      category: data.category || "note",
      project,
      collectionId,
      tags: data.tags || [],
      isEncrypted: data.isEncrypted || false,
      userId,
    });

    if (data.isFavorite) {
      await this.setUserFavorite(userId, note.id, true);
    }

    const saved = await Note.findByPk(note.id, {
      include: this.collectionInclude(),
    });
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    return this.annotateNote(saved || note, userId, new Map(), favoriteNoteIds);
  }

  /**
   * Update a note (owner or edit permission)
   */
  async updateNote(noteId: number, userId: number, data: UpdateNoteData) {
    const access = await this.getNoteAccess(noteId, userId);
    if (
      !access ||
      (access.permission !== "owner" && access.permission !== "edit")
    ) {
      return null;
    }

    const note = access.note;
    const payload: any = {
      title: data.title !== undefined ? data.title : note.title,
      content: data.content !== undefined ? data.content : note.content,
      category: data.category !== undefined ? data.category : note.category,
      tags: data.tags !== undefined ? data.tags : note.tags,
      isEncrypted:
        data.isEncrypted !== undefined ? data.isEncrypted : note.isEncrypted,
    };

    if (access.permission === "owner" && data.collectionId !== undefined) {
      if (data.collectionId) {
        const collectionAccess = await CollectionService.assertCanAdd(
          Number(data.collectionId),
          userId
        );
        payload.collectionId = collectionAccess.collection.id;
        payload.project = collectionAccess.collection.name;
      } else {
        payload.collectionId = null;
        payload.project = null;
      }
    }

    await note.update(payload);

    if (access.permission === "owner" && data.isFavorite !== undefined) {
      await this.setUserFavorite(userId, note.id, Boolean(data.isFavorite));
    }

    const saved = await Note.findByPk(note.id, {
      include: this.collectionInclude(),
    });
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const permissionByNoteId = new Map<number, SharePermission>();
    if (access.permission !== "owner") {
      permissionByNoteId.set(noteId, access.permission);
    }
    return this.annotateNote(
      saved || note,
      userId,
      permissionByNoteId,
      favoriteNoteIds
    );
  }

  /**
   * Delete a note (owner only)
   */
  async deleteNote(noteId: number, userId: number) {
    const note = await Note.findOne({
      where: { id: noteId, userId },
    });

    if (!note) {
      return false;
    }

    await note.destroy();
    return true;
  }

  /**
   * Restore a soft-deleted note (owner only)
   */
  async restoreNote(noteId: number, userId: number) {
    const note = await Note.findOne({
      where: { id: noteId, userId },
      paranoid: false,
    });

    if (!note || !note.deletedAt) {
      return false;
    }

    await note.restore();
    return true;
  }

  /**
   * Get note statistics for a user
   */
  async getNoteStats(userId: number) {
    const totalNotes = await Note.count({ where: { userId } });
    const favoriteNotes = await NoteFavorite.count({ where: { userId } });

    const categoryCounts = await Note.findAll({
      where: { userId },
      attributes: [
        "category",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
      ],
      group: ["category"],
      raw: true,
    });

    return {
      total: totalNotes,
      favorites: favoriteNotes,
      byCategory: categoryCounts,
    };
  }

  /**
   * Toggle the current user's favorite flag.
   * Works for notes they own and notes shared with them.
   */
  async toggleFavorite(noteId: number, userId: number) {
    const access = await this.getNoteAccess(noteId, userId);
    if (!access) {
      return null;
    }

    const existing = await NoteFavorite.findOne({
      where: { noteId, userId },
    });
    await this.setUserFavorite(userId, noteId, !existing);

    const { permissionByNoteId } = await this.getSharedNoteIds(userId);
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    return this.annotateNote(
      access.note,
      userId,
      permissionByNoteId,
      favoriteNoteIds
    );
  }

  /**
   * Get all distinct projects for a user (owned + shared notes)
   */
  async getProjects(userId: number) {
    const { sharedNoteIds } = await this.getSharedNoteIds(userId);

    const projects = await Note.findAll({
      where: {
        [Op.or]: [
          { userId },
          ...(sharedNoteIds.length ? [{ id: { [Op.in]: sharedNoteIds } }] : []),
        ],
        project: { [Op.not]: null as any },
      },
      attributes: [
        [sequelize.fn("DISTINCT", sequelize.col("project")), "project"],
      ],
      raw: true,
    });

    return projects.map((p: any) => p.project).filter(Boolean);
  }

  /**
   * Resolve access for a note
   */
  async getNoteAccess(noteId: number, userId: number) {
    const note = await Note.findByPk(noteId, {
      include: this.collectionInclude(),
    });
    if (!note) return null;

    if (note.userId === userId) {
      return { note, permission: "owner" as const };
    }

    let permission: SharePermission | null = null;
    const share = await NoteShare.findOne({
      where: this.activeShareFilter({ noteId, sharedWithUserId: userId }),
    });
    if (share) permission = share.permission;

    if (note.collectionId) {
      const collection = await Collection.findByPk(note.collectionId);
      if (collection?.userId === userId) {
        permission = "edit";
      } else {
        const collectionShare = await CollectionShare.findOne({
          where: this.activeShareFilter({
            collectionId: note.collectionId,
            sharedWithUserId: userId,
          }),
        });
        if (
          collectionShare &&
          (!permission ||
            (permission === "view" && collectionShare.permission === "edit"))
        ) {
          permission = collectionShare.permission;
        }
      }
    }

    if (!permission) return null;
    return { note, permission };
  }

  /**
   * Share a note with another user by email or username (owner only)
   */
  async shareNote(
    noteId: number,
    ownerId: number,
    identifier: string,
    permission: SharePermission = "view",
    expiresAt: Date | null = null,
  ) {
    const note = await Note.findOne({
      where: { id: noteId, userId: ownerId },
    });

    if (!note) {
      throw Object.assign(
        new Error("Note not found or you are not the owner"),
        {
          status: 404,
        },
      );
    }

    const trimmed = identifier.trim();
    if (!trimmed) {
      throw Object.assign(new Error("Email or username is required"), {
        status: 400,
      });
    }

    const recipient = await User.findOne({
      where: {
        [Op.or]: [{ email: trimmed }, { username: trimmed }],
      },
    });

    if (!recipient) {
      throw Object.assign(
        new Error(`No user found with email or username "${trimmed}"`),
        { status: 404 },
      );
    }

    if (recipient.id === ownerId) {
      throw Object.assign(new Error("You cannot share a note with yourself"), {
        status: 400,
      });
    }

    if (permission !== "view" && permission !== "edit") {
      throw Object.assign(new Error("Permission must be view or edit"), {
        status: 400,
      });
    }

    let share = await NoteShare.findOne({
      where: { noteId, sharedWithUserId: recipient.id },
    });

    if (share) {
      await share.update({ permission, expiresAt });
    } else {
      share = await NoteShare.create({
        noteId,
        sharedByUserId: ownerId,
        sharedWithUserId: recipient.id,
        permission,
        expiresAt,
      });
    }

    const owner = await User.findByPk(ownerId, {
      attributes: ["username", "fullName"],
    });
    const ownerName = owner?.fullName || owner?.username || "Someone";
    await NotificationService.create(
      recipient.id,
      `${ownerName} shared "${note.title}" with you`,
      note.id
    );

    return NoteShare.findByPk(share.id, {
      include: [
        {
          model: User,
          as: "sharedWith",
          attributes: ["id", "username", "email", "fullName"],
        },
      ],
    });
  }

  /**
   * Share a note with multiple users at once (owner only)
   */
  async shareNoteWithMany(
    noteId: number,
    ownerId: number,
    identifiers: string[],
    permission: SharePermission = "view",
    expiresAt: Date | null = null,
  ) {
    const uniqueIdentifiers = [
      ...new Set(
        identifiers.map((id) => id?.trim()).filter((id): id is string => !!id),
      ),
    ];

    if (!uniqueIdentifiers.length) {
      throw Object.assign(
        new Error("At least one email or username is required"),
        { status: 400 },
      );
    }

    const shared: any[] = [];
    const failed: { identifier: string; message: string }[] = [];

    for (const identifier of uniqueIdentifiers) {
      try {
        const share = await this.shareNote(
          noteId,
          ownerId,
          identifier,
          permission,
          expiresAt,
        );
        shared.push(share);
      } catch (error: any) {
        failed.push({
          identifier,
          message: error.message || "Failed to share",
        });
      }
    }

    return { shared, failed };
  }

  /**
   * List shares for a note (owner only)
   */
  async getNoteShares(noteId: number, ownerId: number) {
    const note = await Note.findOne({
      where: { id: noteId, userId: ownerId },
    });

    if (!note) {
      throw Object.assign(
        new Error("Note not found or you are not the owner"),
        {
          status: 404,
        },
      );
    }

    return NoteShare.findAll({
      where: { noteId },
      include: [
        {
          model: User,
          as: "sharedWith",
          attributes: ["id", "username", "email", "fullName"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });
  }

  /**
   * Revoke a share (owner only)
   */
  async revokeShare(noteId: number, ownerId: number, sharedWithUserId: number) {
    const note = await Note.findOne({
      where: { id: noteId, userId: ownerId },
    });

    if (!note) {
      throw Object.assign(
        new Error("Note not found or you are not the owner"),
        {
          status: 404,
        },
      );
    }

    const deleted = await NoteShare.destroy({
      where: { noteId, sharedWithUserId },
    });

    if (!deleted) {
      throw Object.assign(new Error("Share not found"), { status: 404 });
    }

    return true;
  }
}

export default new NoteService();
