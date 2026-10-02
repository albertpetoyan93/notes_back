import { Response } from "express";
import NoteService from "../services/NoteService";

export default class NoteController {
  static autofill = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const matches = await NoteService.autofill(
        userId,
        String(req.query.host || ""),
        String(req.query.q || "")
      );
      res.json(matches);
    } catch (error: any) {
      const status = error?.status || 500;
      if (status === 400) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error matching logins:", error);
      res.status(500).json({ message: "Error matching logins" });
    }
  };

  static getNotes = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { category, project, tag, search, isFavorite, sharedOnly, trash, collection, company } =
        req.query;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const notes = await NoteService.getNotes(userId, {
        category,
        project,
        tag,
        search,
        isFavorite: isFavorite === "true",
        sharedOnly: sharedOnly === "true",
        trash: trash === "true",
        collectionId:
          collection && !isNaN(parseInt(String(collection)))
            ? parseInt(String(collection))
            : undefined,
        companyId:
          company && !isNaN(parseInt(String(company)))
            ? parseInt(String(company))
            : undefined,
      });

      res.json(notes);
    } catch (error) {
      console.error("Error fetching notes:", error);
      res.status(500).json({ message: "Error fetching notes" });
    }
  };

  // Get a single note
  static getNote = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const noteId = parseInt(id);
      if (isNaN(noteId)) {
        return res.status(400).json({ message: "Invalid note ID" });
      }

      const note = await NoteService.getNoteById(noteId, userId);

      if (!note) {
        return res.status(404).json({ message: "Note not found" });
      }

      res.json(note);
    } catch (error) {
      console.error("Error fetching note:", error);
      res.status(500).json({ message: "Error fetching note" });
    }
  };

  // Create a new note
  static createNote = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;

      const {
        title,
        content,
        category,
        project,
        tags,
        isFavorite,
        isEncrypted,
        collectionId,
        collectionIds,
      } = req.body;

      const note = await NoteService.createNote(userId, {
        title,
        content,
        category,
        project,
        tags,
        isFavorite,
        isEncrypted,
        collectionId,
        collectionIds,
      });

      res.status(201).json(note);
    } catch (error) {
      console.error("Error creating note:", error);
      res.status(500).json({ message: "Error creating note" });
    }
  };

  static exportNotes = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const backup = await NoteService.exportNotes(userId);
      res.json(backup);
    } catch (error) {
      console.error("Error exporting notes:", error);
      res.status(500).json({ message: "Error exporting notes" });
    }
  };

  static importNotes = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const notes = Array.isArray(req.body) ? req.body : req.body?.notes;
      const result = await NoteService.importNotes(userId, notes);
      res.status(201).json(result);
    } catch (error: any) {
      console.error("Error importing notes:", error);
      res.status(error.status || 500).json({ message: "Error importing notes" });
    }
  };

  // Toggle favorite for the current user
  static toggleFavorite = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const noteId = parseInt(id);
      if (isNaN(noteId)) {
        return res.status(400).json({ message: "Invalid note ID" });
      }

      const note = await NoteService.toggleFavorite(noteId, userId);
      if (!note) {
        return res.status(404).json({ message: "Note not found" });
      }

      res.json(note);
    } catch (error) {
      console.error("Error toggling favorite:", error);
      res.status(500).json({ message: "Error updating favorite" });
    }
  };

  // Update a note
  static updateNote = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const noteId = parseInt(id);
      if (isNaN(noteId)) {
        return res.status(400).json({ message: "Invalid note ID" });
      }

      const {
        title,
        content,
        category,
        project,
        tags,
        isFavorite,
        isEncrypted,
        collectionId,
        collectionIds,
      } = req.body;

      const note = await NoteService.updateNote(noteId, userId, {
        title,
        content,
        category,
        project,
        tags,
        isFavorite,
        isEncrypted,
        collectionId,
        collectionIds,
      });

      if (!note) {
        return res.status(404).json({ message: "Note not found" });
      }

      res.json(note);
    } catch (error) {
      console.error("Error updating note:", error);
      res.status(500).json({ message: "Error updating note" });
    }
  };

  // Delete a note
  static deleteNote = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const noteId = parseInt(id);
      if (isNaN(noteId)) {
        return res.status(400).json({ message: "Invalid note ID" });
      }

      const deleted = await NoteService.deleteNote(noteId, userId);

      if (!deleted) {
        return res.status(404).json({ message: "Note not found" });
      }

      res.json({ message: "Note moved to trash" });
    } catch (error) {
      console.error("Error deleting note:", error);
      res.status(500).json({ message: "Error deleting note" });
    }
  };

  // Restore a note from trash
  static restoreNote = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const noteId = parseInt(id);
      if (isNaN(noteId)) {
        return res.status(400).json({ message: "Invalid note ID" });
      }

      const restored = await NoteService.restoreNote(noteId, userId);
      if (!restored) {
        return res.status(404).json({ message: "Note not found in trash" });
      }

      res.json({ message: "Note restored" });
    } catch (error) {
      console.error("Error restoring note:", error);
      res.status(500).json({ message: "Error restoring note" });
    }
  };

  static emptyTrash = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const deleted = await NoteService.emptyTrash(userId);
      res.json({ deleted });
    } catch (error) {
      console.error("Error emptying trash:", error);
      res.status(500).json({ message: "Error emptying trash" });
    }
  };

  static bulkUpdate = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const { noteIds, action, collectionId } = req.body || {};
      if (action !== "trash" && action !== "move") {
        return res.status(400).json({ message: "Invalid action" });
      }
      const result = await NoteService.bulkUpdate(
        userId,
        Array.isArray(noteIds) ? noteIds : [],
        action,
        collectionId ?? null
      );
      res.json(result);
    } catch (error: any) {
      console.error("Error updating notes:", error);
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error updating notes",
      });
    }
  };

  // Get note statistics
  static getNoteStats = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const stats = await NoteService.getNoteStats(userId);

      res.json(stats);
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ message: "Error fetching statistics" });
    }
  };

  // Get all projects
  static getProjects = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const projects = await NoteService.getProjects(userId);
      res.json(projects);
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ message: "Error fetching projects" });
    }
  };

  // Share a note with another user (or multiple)
  static shareNote = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;
      const { identifier, identifiers, email, username, permission, expiresIn } =
        req.body;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const noteId = parseInt(id);
      if (isNaN(noteId)) {
        return res.status(400).json({ message: "Invalid note ID" });
      }

      const list: string[] = Array.isArray(identifiers)
        ? identifiers
        : [identifier || email || username].filter(Boolean);

      if (!list.length) {
        return res
          .status(400)
          .json({ message: "At least one email or username is required" });
      }

      const allowedExpiry = [1, 7, 30];
      let expiresAt: Date | null = null;
      if (expiresIn && expiresIn !== "never") {
        const days = Number(expiresIn);
        if (!allowedExpiry.includes(days)) {
          return res.status(400).json({ message: "Invalid expiry" });
        }
        expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      }

      const result = await NoteService.shareNoteWithMany(
        noteId,
        userId,
        list,
        permission || "view",
        expiresAt,
      );

      if (!result.shared.length && result.failed.length) {
        return res.status(400).json({
          message: result.failed.map((f) => f.message).join("; "),
          shared: result.shared,
          failed: result.failed,
        });
      }

      res.status(201).json(result);
    } catch (error: any) {
      console.error("Error sharing note:", error);
      res
        .status(error.status || 500)
        .json({ message: error.message || "Error sharing note" });
    }
  };

  // List shares for a note
  static getNoteShares = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const noteId = parseInt(id);
      if (isNaN(noteId)) {
        return res.status(400).json({ message: "Invalid note ID" });
      }

      const shares = await NoteService.getNoteShares(noteId, userId);
      res.json(shares);
    } catch (error: any) {
      console.error("Error fetching shares:", error);
      res
        .status(error.status || 500)
        .json({ message: error.message || "Error fetching shares" });
    }
  };

  // Revoke a share
  static revokeShare = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id, userId: sharedWithUserId } = req.params;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const noteId = parseInt(id);
      const targetUserId = parseInt(sharedWithUserId);
      if (isNaN(noteId) || isNaN(targetUserId)) {
        return res.status(400).json({ message: "Invalid ID" });
      }

      await NoteService.revokeShare(noteId, userId, targetUserId);
      res.json({ message: "Share revoked successfully" });
    } catch (error: any) {
      console.error("Error revoking share:", error);
      res
        .status(error.status || 500)
        .json({ message: error.message || "Error revoking share" });
    }
  };
}
