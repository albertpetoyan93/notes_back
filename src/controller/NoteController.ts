import { Response } from "express";
import NoteService from "../services/NoteService";
import AuditService from "../services/AuditService";
import NotificationService from "../services/NotificationService";
import User from "../models/User";

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
      // The extension now holds these passwords.
      for (const match of matches) {
        await AuditService.record({
          actorId: userId,
          action: "item_autofilled",
          noteId: match.id,
          details: { host: String(req.query.host || "").slice(0, 200) },
          req,
        });
      }
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
      await AuditService.record({
        actorId: userId,
        action: "item_created",
        noteId: (note as any)?.id,
        req,
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
      const exported = (backup as any)?.notes;
      await AuditService.record({
        actorId: userId,
        action: "vault_exported",
        details: Array.isArray(exported) ? { count: exported.length } : {},
        req,
      });
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
      await AuditService.record({
        actorId: userId,
        action: "vault_imported",
        details: { count: (result as any)?.imported },
        req,
      });
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
      await AuditService.record({
        actorId: userId,
        action: "item_updated",
        noteId,
        details: {
          changed: ["title", "content", "category", "tags", "collectionIds"].filter(
            (key) => req.body?.[key] !== undefined
          ),
        },
        req,
      });

      res.json(note);
    } catch (error: any) {
      if (error?.status === 409) {
        return res.status(409).json({ message: error.message });
      }
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

      await AuditService.record({ actorId: userId, action: "item_trashed", noteId, req });
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

      await AuditService.record({ actorId: userId, action: "item_restored", noteId, req });
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
      if (deleted) {
        await AuditService.record({
          actorId: userId,
          action: "trash_emptied",
          details: { count: deleted },
          req,
        });
      }
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
      for (const noteId of (result as { noteIds?: number[] }).noteIds || []) {
        await AuditService.record({
          actorId: userId,
          action: action === "trash" ? "item_trashed" : "item_moved",
          noteId,
          collectionId: action === "move" ? collectionId ?? null : null,
          req,
        });
      }
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

      for (const share of result.shared) {
        if (!share) continue;
        await AuditService.record({
          actorId: userId,
          action: "item_shared",
          noteId,
          targetUserId: share.sharedWithUserId,
          details: { permission: share.permission, expiresAt: share.expiresAt ?? null },
          req,
        });
      }

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
      await AuditService.record({
        actorId: userId,
        action: "item_share_revoked",
        noteId,
        targetUserId,
        req,
      });
      res.json({ message: "Share revoked successfully" });
    } catch (error: any) {
      console.error("Error revoking share:", error);
      res
        .status(error.status || 500)
        .json({ message: error.message || "Error revoking share" });
    }
  };

  // Remove an item someone shared with you from your list
  static leaveShare = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const noteId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(noteId)) return res.status(400).json({ message: "Invalid note ID" });

      const result = await NoteService.leaveShare(noteId, userId);
      if (result.removed) {
        await AuditService.record({
          actorId: userId,
          action: "item_share_left",
          noteId,
          targetUserId: result.ownerId,
          req,
        });
        const me = await User.findByPk(userId, { attributes: ["username", "fullName"] });
        await NotificationService.create(
          result.ownerId,
          `${me?.fullName || me?.username || "Someone"} removed "${result.title}" from their list`,
          noteId
        );
      }
      res.json({ removed: result.removed, collections: result.collections });
    } catch (error: any) {
      if (error?.status) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error("Error leaving share:", error);
      res.status(500).json({ message: "Error removing the item" });
    }
  };

  // The vault app reports when a secret field is shown or copied
  static recordEvent = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const noteId = parseInt(req.params.id);
      const action = req.body?.action;
      const field = String(req.body?.field || "").trim().slice(0, 100);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(noteId) || (action !== "field_revealed" && action !== "field_copied")) {
        return res.status(400).json({ message: "Invalid event" });
      }
      const access = await NoteService.getNoteAccess(noteId, userId);
      if (!access) return res.status(404).json({ message: "Note not found" });

      await AuditService.record({
        actorId: userId,
        action,
        noteId,
        details: field ? { field } : {},
        req,
      });
      res.status(204).end();
    } catch (error) {
      console.error("Error recording event:", error);
      res.status(500).json({ message: "Error recording event" });
    }
  };

  // Everyone who can open an item, and how (owner, or company owners/admins)
  static accessList = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const noteId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(noteId)) return res.status(400).json({ message: "Invalid note ID" });
      const access = await NoteService.getAccessList(noteId, userId);
      if (!access) return res.status(404).json({ message: "Note not found" });
      res.json(access);
    } catch (error) {
      console.error("Error loading access:", error);
      res.status(500).json({ message: "Error loading who has access" });
    }
  };

  // History of one item (owner, or company owners/admins)
  static activity = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const noteId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(noteId)) return res.status(400).json({ message: "Invalid note ID" });
      const before = parseInt(String(req.query.before || ""));
      const page = await AuditService.noteHistory(
        noteId,
        userId,
        isNaN(before) ? undefined : before
      );
      if (!page) return res.status(404).json({ message: "Note not found" });
      res.json(page);
    } catch (error) {
      console.error("Error loading activity:", error);
      res.status(500).json({ message: "Error loading activity" });
    }
  };
}
