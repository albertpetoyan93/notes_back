import Note from "../models/Note";
import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface NoteFilters {
  category?: string;
  project?: string;
  search?: string;
  isFavorite?: boolean;
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
  /**
   * Get all notes for a user with optional filters
   */
  async getNotes(userId: number, filters?: NoteFilters) {
    const whereClause: any = { userId };

    if (filters?.category && filters.category !== "all") {
      whereClause.category = filters.category;
    }

    if (filters?.project && filters.project !== "all") {
      whereClause.project = filters.project;
    }

    if (filters?.isFavorite) {
      whereClause.isFavorite = true;
    }

    if (filters?.search) {
      const searchTerm = `%${filters.search}%`;
      whereClause[Op.or] = [
        { title: { [Op.iLike]: searchTerm } },
        sequelize.where(sequelize.cast(sequelize.col("content"), "text"), {
          [Op.iLike]: searchTerm,
        }),
      ];
    }

    const notes = await Note.findAll({
      where: whereClause,
      order: [["updatedAt", "DESC"]],
    });

    // Model's getter automatically decrypts content
    return notes;
  }

  /**
   * Get a single note by ID
   */
  async getNoteById(noteId: number, userId: number) {
    const note = await Note.findOne({
      where: { id: noteId, userId },
    });

    // Model's getter automatically decrypts content
    return note;
  }

  /**
   * Create a new note
   */
  async createNote(userId: number, data: CreateNoteData) {
    // Model hooks automatically handle encryption/decryption
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

    return note;
  }

  /**
   * Update a note
   */
  async updateNote(noteId: number, userId: number, data: UpdateNoteData) {
    const note = await Note.findOne({
      where: { id: noteId, userId },
    });

    if (!note) {
      return null;
    }

    // Model hooks automatically handle encryption/decryption
    await note.update({
      title: data.title !== undefined ? data.title : note.title,
      content: data.content !== undefined ? data.content : note.content,
      category: data.category !== undefined ? data.category : note.category,
      project: data.project !== undefined ? data.project : note.project,
      tags: data.tags !== undefined ? data.tags : note.tags,
      isFavorite:
        data.isFavorite !== undefined ? data.isFavorite : note.isFavorite,
      isEncrypted:
        data.isEncrypted !== undefined ? data.isEncrypted : note.isEncrypted,
    });

    return note;
  }

  /**
   * Delete a note
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
   * Toggle favorite status of a note
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

    return note;
  }

  /**
   * Get all distinct projects for a user
   */
  async getProjects(userId: number) {
    const projects = await Note.findAll({
      where: {
        userId,
        project: { [Op.not]: null as any },
      },
      attributes: [
        [sequelize.fn("DISTINCT", sequelize.col("project")), "project"],
      ],
      raw: true,
    });

    return projects.map((p: any) => p.project).filter(Boolean);
  }
}

export default new NoteService();
