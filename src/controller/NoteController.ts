import { Response } from "express";
import NoteService from "../services/NoteService";
import AuditService from "../services/AuditService";
import NotificationService from "../services/NotificationService";
import User from "../models/User";
import UserSession from "../models/UserSession";
import { PlanLimitError, planLimitBody } from "../services/EntitlementService";
import E2EItemService, { e2eConflictBody, isE2EAnswer } from "../services/E2EItemService";

// Only accounts that turned on end-to-end encryption may store sealed items.
async function e2eAccount(userId: number) {
  const user = await User.findByPk(userId, { attributes: ["id", "e2eEnabled"] });
  return !!user?.e2eEnabled;
}

// Private keys go only to the browser extension's own session, not to the vault's.
async function fromExtension(req: any) {
  const sessionId = req.user?.sessionId;
  if (!sessionId) return false;
  const session = await UserSession.findByPk(sessionId, { attributes: ["kind", "userId"] });
  return !!session && session.kind === "extension" && session.userId === req.user?.id;
}

export default class NoteController {
  /** Personal items not yet encrypted in the browser, readable, for it to encrypt. */
  static e2ePending = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!(await e2eAccount(userId))) return res.status(403).json({ message: "End-to-end encryption is off." });
      res.json(await E2EItemService.pending(userId));
    } catch (error) {
      console.error("Error listing items to encrypt:", error);
      res.status(500).json({ message: "Error listing items to encrypt" });
    }
  };

  /** Store items the browser encrypted, and delete their readable copies. */
  static e2eMigrate = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!(await e2eAccount(userId))) return res.status(403).json({ message: "End-to-end encryption is off." });
      const result = await E2EItemService.migrate(userId, req.body?.items);
      if (result.moved) {
        await AuditService.record({ actorId: userId, action: "items_encrypted", details: { count: result.moved }, req });
      }
      res.json(result);
    } catch (error) {
      console.error("Error storing encrypted items:", error);
      res.status(500).json({ message: "Error storing encrypted items" });
    }
  };

  /** Sealed logins to fill, for the extension to open and match itself. */
  static e2eAutofill = async (req: any, res: Response) => {
    try {
      res.json({ items: await NoteService.sealedAutofillItems(req.user?.id) });
    } catch (error) {
      console.error("Error listing sealed logins:", error);
      res.status(500).json({ message: "Error listing logins" });
    }
  };

  /** Make end-to-end items readable again, so they can be shared. */
  static e2eUnseal = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const result = await E2EItemService.unseal(userId, req.body?.items, async (noteId) => {
        const access = await NoteService.getNoteAccess(noteId, userId);
        return access?.permission === "owner" || access?.permission === "edit";
      });
      res.json(result);
    } catch (error: any) {
      if (error?.status === 400) return res.status(400).json({ message: error.message });
      console.error("Error unsealing items:", error);
      res.status(500).json({ message: "Error unsealing items" });
    }
  };

  /** Passkeys for a site, for the extension to sign in with. */
  static passkeys = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (!(await fromExtension(req))) {
        return res.status(403).json({ message: "Only the 2keevo extension can use passkeys." });
      }
      const host = String(req.query.host || "");
      const passkeys = await NoteService.passkeysForSite(userId, host);
      for (const noteId of new Set(passkeys.map((passkey) => passkey.noteId))) {
        await AuditService.record({
          actorId: userId,
          action: "item_autofilled",
          noteId,
          details: { host: host.slice(0, 200), passkey: true },
          req,
        });
      }
      res.json(passkeys);
    } catch (error: any) {
      if (error?.status === 400) return res.status(400).json({ message: error.message });
      console.error("Error finding passkeys:", error);
      res.status(500).json({ message: "Error finding passkeys" });
    }
  };

  /** Save a passkey the extension made, on a chosen login or a new one. */
  static savePasskey = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (!(await fromExtension(req))) {
        return res.status(403).json({ message: "Only the 2keevo extension can save passkeys." });
      }
      const result = await NoteService.savePasskey(userId, {
        noteId: req.body?.noteId ?? null,
        passkey: req.body?.passkey,
      });
      await AuditService.record({
        actorId: userId,
        action: result.created ? "item_created" : "item_updated",
        noteId: result.noteId,
        details: { passkey: String(req.body?.passkey?.rpId || "").slice(0, 200) },
        req,
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error: any) {
      const status = error?.status;
      if (status === 400 || status === 403 || status === 409) {
        return res.status(status).json({ message: error.message });
      }
      console.error("Error saving passkey:", error);
      res.status(500).json({ message: "Error saving passkey" });
    }
  };


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
        e2e,
        version,
        e2eKeys,
      } = req.body;
      if (e2e && !(await e2eAccount(userId))) {
        return res.status(403).json({ message: "End-to-end encryption is off." });
      }

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
        e2e,
        version,
        e2eKeys,
      });
      await AuditService.record({
        actorId: userId,
        action: "item_created",
        noteId: (note as any)?.id,
        req,
      });

      res.status(201).json(note);
    } catch (error: any) {
      if (isE2EAnswer(error)) return res.status(409).json(e2eConflictBody(error));
      // Rules people can act on (a company's password length, a collection they can't use).
      if ((error as any)?.status >= 400 && (error as any)?.status < 500) {
        return res.status((error as any).status).json({ message: (error as any).message });
      }
      console.error("Error creating note:", error);
      res.status(500).json({ message: "Error creating note" });
    }
  };

  static breachStatus = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      res.json(await NoteService.breachStatus(userId));
    } catch (error) {
      console.error("Error reading breach results:", error);
      res.status(500).json({ message: "Error reading breach results" });
    }
  };

  static saveBreachResults = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      res.json(await NoteService.saveBreachResults(userId, req.body?.results));
    } catch (error: any) {
      if (error?.status === 400) return res.status(400).json({ message: error.message });
      console.error("Error saving breach results:", error);
      res.status(500).json({ message: "Error saving breach results" });
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
        encData,
        version,
        e2eKeys,
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
        encData,
        version,
        e2eKeys,
      });

      if (!note) {
        return res.status(404).json({ message: "Note not found" });
      }
      await AuditService.record({
        actorId: userId,
        action: "item_updated",
        noteId,
        details: {
          changed: ["title", "content", "category", "tags", "collectionIds", "encData"].filter(
            (key) => req.body?.[key] !== undefined
          ),
        },
        req,
      });

      res.json(note);
    } catch (error: any) {
      if (isE2EAnswer(error)) return res.status(409).json(e2eConflictBody(error));
      if (error?.status >= 400 && error?.status < 500) {
        return res.status(error.status).json({ message: error.message });
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
        collectionId ?? null,
        req.body?.e2eKeys
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
      if (isE2EAnswer(error)) return res.status(409).json(e2eConflictBody(error));
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
        req.body?.e2eKeys,
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
      if (isE2EAnswer(error)) return res.status(409).json(e2eConflictBody(error));
      if (error instanceof PlanLimitError) return res.status(402).json(planLimitBody(error));
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
  static listVersions = async (req: any, res: Response) => {
    try {
      const versions = await NoteService.listVersions(Number(req.params.id), req.user?.id);
      if (!versions) return res.status(404).json({ message: "Item not found" });
      res.json(versions);
    } catch (error) {
      console.error("Error listing versions:", error);
      res.status(500).json({ message: "Error listing versions" });
    }
  };

  static getVersion = async (req: any, res: Response) => {
    try {
      const noteId = Number(req.params.id);
      const version = await NoteService.getVersion(
        noteId,
        Number(req.params.versionId),
        req.user?.id
      );
      if (!version) return res.status(404).json({ message: "Version not found" });
      // Opening a version shows its secrets, like opening the item does.
      await AuditService.record({
        actorId: req.user?.id,
        action: "item_version_viewed",
        noteId,
        details: { versionId: version.id, versionDate: version.createdAt },
        req,
      });
      res.json(version);
    } catch (error) {
      console.error("Error opening version:", error);
      res.status(500).json({ message: "Error opening version" });
    }
  };

  static restoreVersion = async (req: any, res: Response) => {
    try {
      const noteId = Number(req.params.id);
      const result = await NoteService.restoreVersion(
        noteId,
        Number(req.params.versionId),
        req.user?.id
      );
      if (!result) return res.status(404).json({ message: "Version not found" });
      await AuditService.record({
        actorId: req.user?.id,
        action: "item_version_restored",
        noteId,
        details: { versionId: result.version.id, versionDate: result.version.createdAt },
        req,
      });
      res.json(result.note);
    } catch (error: any) {
      if (error?.status === 409) return res.status(409).json({ message: error.message });
      console.error("Error restoring version:", error);
      res.status(500).json({ message: "Error restoring version" });
    }
  };

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
