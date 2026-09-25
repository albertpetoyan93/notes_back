import Note from "../models/Note";
import NoteShare, { SharePermission } from "../models/NoteShare";
import User from "../models/User";
import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface NoteFilters {
  category?: string;
  project?: string;
  search?: string;
  isFavorite?: boolean;
  sharedOnly?: boolean;
}

interface CreateNoteData {
  title: string;
  content: any;
  category: "note" | "password" | "login" | "command" | "ssh" | "db" | "other";
  project?: string;
  tags?: string[];
  isFavorite?: boolean;
  isEncrypted?: boolean;
}

interface UpdateNoteData {
  title?: string;
  content?: any;
  category?: "note" | "password" | "login" | "command" | "ssh" | "db" | "other";
  project?: string;
  tags?: string[];
  isFavorite?: boolean;
  isEncrypted?: boolean;
}

class NoteService {
  private async getSharedNoteIds(userId: number) {
    const shares = await NoteShare.findAll({
      where: { sharedWithUserId: userId },
      attributes: ["noteId", "permission"],
    });

    const permissionByNoteId = new Map<number, SharePermission>();
    shares.forEach((share) => {
      permissionByNoteId.set(share.noteId, share.permission);
    });

    return {
      sharedNoteIds: shares.map((s) => s.noteId),
      permissionByNoteId,
    };
  }

  private annotateNote(
    note: Note,
    userId: number,
    permissionByNoteId: Map<number, SharePermission>
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
    };
  }

  /**
   * Get all notes for a user (owned + shared) with optional filters
   */
  async getNotes(userId: number, filters?: NoteFilters) {
    const { sharedNoteIds, permissionByNoteId } =
      await this.getSharedNoteIds(userId);

    const ownershipClause = filters?.sharedOnly
      ? sharedNoteIds.length
        ? { id: { [Op.in]: sharedNoteIds } }
        : { id: { [Op.in]: [-1] } }
      : {
          [Op.or]: [
            { userId },
            ...(sharedNoteIds.length
              ? [{ id: { [Op.in]: sharedNoteIds } }]
              : []),
          ],
        };

    const whereClause: any = { ...ownershipClause };

    if (filters?.category && filters.category !== "all") {
      whereClause.category = filters.category;
    }

    if (filters?.project && filters.project !== "all") {
      whereClause.project = filters.project;
    }

    if (filters?.isFavorite) {
      whereClause.isFavorite = true;
      whereClause.userId = userId; // favorites only apply to owned notes
    }

    if (filters?.search) {
      const searchTerm = `%${filters.search}%`;
      whereClause[Op.and] = [
        {
          [Op.or]: [
            { title: { [Op.iLike]: searchTerm } },
            sequelize.where(sequelize.cast(sequelize.col("content"), "text"), {
              [Op.iLike]: searchTerm,
            }),
          ],
        },
      ];
    }

    const notes = await Note.findAll({
      where: whereClause,
      order: [["updatedAt", "DESC"]],
    });

    return notes.map((note) =>
      this.annotateNote(note, userId, permissionByNoteId)
    );
  }

  /**
   * Get a single note by ID if user owns it or it was shared with them
   */
  async getNoteById(noteId: number, userId: number) {
    const { sharedNoteIds, permissionByNoteId } =
      await this.getSharedNoteIds(userId);

    const note = await Note.findOne({
      where: {
        id: noteId,
        [Op.or]: [
          { userId },
          ...(sharedNoteIds.includes(noteId)
            ? [{ id: noteId }]
            : []),
        ],
      },
    });

    if (!note) return null;

    return this.annotateNote(note, userId, permissionByNoteId);
  }

  /**
   * Create a new note
   */
  async createNote(userId: number, data: CreateNoteData) {
    const note = await Note.create({
      title: data.title,
      content: data.content,
      category: data.category || "note",
      project: data.project || undefined,
      tags: data.tags || [],
      isFavorite: data.isFavorite || false,
      isEncrypted: data.isEncrypted || false,
      userId,
    });

    return this.annotateNote(note, userId, new Map());
  }

  /**
   * Update a note (owner or edit permission)
   */
  async updateNote(noteId: number, userId: number, data: UpdateNoteData) {
    const access = await this.getNoteAccess(noteId, userId);
    if (!access || (access.permission !== "owner" && access.permission !== "edit")) {
      return null;
    }

    const note = access.note;

    await note.update({
      title: data.title !== undefined ? data.title : note.title,
      content: data.content !== undefined ? data.content : note.content,
      category: data.category !== undefined ? data.category : note.category,
      project: data.project !== undefined ? data.project : note.project,
      tags: data.tags !== undefined ? data.tags : note.tags,
      isFavorite:
        data.isFavorite !== undefined && access.permission === "owner"
          ? data.isFavorite
          : note.isFavorite,
      isEncrypted:
        data.isEncrypted !== undefined ? data.isEncrypted : note.isEncrypted,
    });

    const permissionByNoteId = new Map<number, SharePermission>();
    if (access.permission !== "owner") {
      permissionByNoteId.set(noteId, access.permission);
    }

    return this.annotateNote(note, userId, permissionByNoteId);
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
   * Get note statistics for a user
   */
  async getNoteStats(userId: number) {
    const totalNotes = await Note.count({ where: { userId } });
    const favoriteNotes = await Note.count({
      where: { userId, isFavorite: true },
    });

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
   * Toggle favorite status of a note (owner only)
   */
  async toggleFavorite(noteId: number, userId: number) {
    const note = await Note.findOne({
      where: { id: noteId, userId },
    });

    if (!note) {
      return null;
    }

    await note.update({
      isFavorite: !note.isFavorite,
    });

    return this.annotateNote(note, userId, new Map());
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
          ...(sharedNoteIds.length
            ? [{ id: { [Op.in]: sharedNoteIds } }]
            : []),
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
    const note = await Note.findByPk(noteId);
    if (!note) return null;

    if (note.userId === userId) {
      return { note, permission: "owner" as const };
    }

    const share = await NoteShare.findOne({
      where: { noteId, sharedWithUserId: userId },
    });

    if (!share) return null;

    return { note, permission: share.permission };
  }

  /**
   * Share a note with another user by email or username (owner only)
   */
  async shareNote(
    noteId: number,
    ownerId: number,
    identifier: string,
    permission: SharePermission = "view"
  ) {
    const note = await Note.findOne({
      where: { id: noteId, userId: ownerId },
    });

    if (!note) {
      throw Object.assign(new Error("Note not found or you are not the owner"), {
        status: 404,
      });
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
        { status: 404 }
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
      await share.update({ permission });
    } else {
      share = await NoteShare.create({
        noteId,
        sharedByUserId: ownerId,
        sharedWithUserId: recipient.id,
        permission,
      });
    }

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
    permission: SharePermission = "view"
  ) {
    const uniqueIdentifiers = [
      ...new Set(
        identifiers
          .map((id) => id?.trim())
          .filter((id): id is string => !!id)
      ),
    ];

    if (!uniqueIdentifiers.length) {
      throw Object.assign(
        new Error("At least one email or username is required"),
        { status: 400 }
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
          permission
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
      throw Object.assign(new Error("Note not found or you are not the owner"), {
        status: 404,
      });
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
      throw Object.assign(new Error("Note not found or you are not the owner"), {
        status: 404,
      });
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
