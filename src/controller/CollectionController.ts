import { Response } from "express";
import CollectionService from "../services/CollectionService";
import AuditService from "../services/AuditService";
import E2EItemService, { e2eConflictBody, isE2EAnswer } from "../services/E2EItemService";
import NotificationService from "../services/NotificationService";
import User from "../models/User";
import { PlanLimitError, planLimitBody } from "../services/EntitlementService";

const parseExpiry = (expiresIn: unknown) => {
  if (!expiresIn || expiresIn === "never") return null;
  const days = Number(expiresIn);
  if (![1, 7, 30].includes(days)) return undefined;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
};

export default class CollectionController {
  /** End-to-end background work for the collections this person manages. */
  static e2eTasks = async (req: any, res: Response) => {
    try {
      res.json(await E2EItemService.tasks(req.user?.id));
    } catch (error) {
      console.error("Error listing key tasks:", error);
      res.status(500).json({ message: "Error listing key tasks" });
    }
  };

  /** Collection keys made in the browser: a new key, or copies for people who just got access. */
  static e2eKeys = async (req: any, res: Response) => {
    try {
      await E2EItemService.applyKeys(req.user?.id, { collections: req.body?.collections });
      res.json({ ok: true });
    } catch (error: any) {
      if (error?.status >= 400 && error?.status < 500) return res.status(error.status).json({ message: error.message });
      console.error("Error storing collection keys:", error);
      res.status(500).json({ message: "Error storing collection keys" });
    }
  };

  /** Collection names encrypted (or made readable) in an owner's or admin's browser. */
  static e2eNames = async (req: any, res: Response) => {
    try {
      res.json(await E2EItemService.applyNames(req.user?.id, req.body?.items));
    } catch (error: any) {
      if (error?.status >= 400 && error?.status < 500) return res.status(error.status).json({ message: error.message });
      console.error("Error storing collection names:", error);
      res.status(500).json({ message: "Error storing collection names" });
    }
  };

  /** A new collection key after someone lost access. */
  static e2eRotate = async (req: any, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid collection ID" });
      res.json(await E2EItemService.rotate(req.user?.id, id, req.body));
    } catch (error: any) {
      if (error?.status >= 400 && error?.status < 500) return res.status(error.status).json({ message: error.message });
      console.error("Error replacing a collection key:", error);
      res.status(500).json({ message: "Error replacing the collection key" });
    }
  };

  static list = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      res.json(await CollectionService.list(userId));
    } catch (error) {
      console.error("Error listing collections:", error);
      res.status(500).json({ message: "Error listing collections" });
    }
  };

  static create = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const collection = await CollectionService.create(userId, req.body?.name || "", req.body);
      res.status(201).json(collection);
    } catch (error: any) {
      if (error instanceof PlanLimitError) return res.status(402).json(planLimitBody(error));
      console.error("Error creating collection:", error);
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error creating collection",
      });
    }
  };

  static rename = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid collection ID" });
      const collection = await CollectionService.rename(id, userId, req.body?.name || "", req.body);
      if (!collection) return res.status(404).json({ message: "Collection not found" });
      res.json(collection);
    } catch (error: any) {
      console.error("Error renaming collection:", error);
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error renaming collection",
      });
    }
  };

  static remove = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid collection ID" });
      const removed = await CollectionService.remove(id, userId);
      if (!removed) return res.status(404).json({ message: "Collection not found" });
      res.json({ message: "Collection deleted" });
    } catch (error) {
      console.error("Error deleting collection:", error);
      res.status(500).json({ message: "Error deleting collection" });
    }
  };

  static addNotes = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid collection ID" });
      const noteIds = Array.isArray(req.body?.noteIds) ? req.body.noteIds : [];
      const result = await CollectionService.addNotes(id, userId, noteIds, req.body?.e2eKeys);
      res.json(result);
    } catch (error: any) {
      if (isE2EAnswer(error)) return res.status(409).json(e2eConflictBody(error));
      console.error("Error adding notes to collection:", error);
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error adding notes",
      });
    }
  };

  static removeNote = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      const noteId = parseInt(req.params.noteId);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id) || isNaN(noteId)) {
        return res.status(400).json({ message: "Invalid ID" });
      }
      const removed = await CollectionService.removeNote(id, userId, noteId);
      if (!removed) return res.status(404).json({ message: "Note not found" });
      res.json({ message: "Removed from collection" });
    } catch (error) {
      console.error("Error removing note from collection:", error);
      res.status(500).json({ message: "Error removing note" });
    }
  };

  static availableNotes = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid collection ID" });
      res.json(await CollectionService.availableNotes(id, userId));
    } catch (error: any) {
      console.error("Error listing notes for collection:", error);
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error listing notes",
      });
    }
  };

  static shares = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid collection ID" });
      const shares = await CollectionService.listShares(id, userId);
      if (!shares) return res.status(404).json({ message: "Collection not found" });
      res.json(shares);
    } catch (error) {
      console.error("Error listing collection shares:", error);
      res.status(500).json({ message: "Error listing shares" });
    }
  };

  static share = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid collection ID" });

      const { identifier, identifiers, email, username, permission } = req.body;
      const list: string[] = Array.isArray(identifiers)
        ? identifiers
        : [identifier || email || username].filter(Boolean);
      if (!list.length) {
        return res.status(400).json({ message: "At least one email or username is required" });
      }

      const expiresAt = parseExpiry(req.body?.expiresIn);
      if (expiresAt === undefined) {
        return res.status(400).json({ message: "Invalid expiry" });
      }

      const result = await CollectionService.shareWithMany(
        id,
        userId,
        list,
        permission || "view",
        expiresAt,
        req.body?.e2eKeys
      );
      for (const share of result.shared) {
        if (!share) continue;
        await AuditService.record({
          actorId: userId,
          action: "collection_shared",
          collectionId: id,
          targetUserId: share.sharedWithUserId,
          details: { permission: share.permission, expiresAt: share.expiresAt ?? null },
          req,
        });
      }
      if (!result.shared.length && result.failed.length) {
        return res.status(400).json({
          message: result.failed.map((item) => item.message).join("; "),
          shared: result.shared,
          failed: result.failed,
        });
      }
      res.status(201).json(result);
    } catch (error: any) {
      if (isE2EAnswer(error)) return res.status(409).json(e2eConflictBody(error));
      if (error instanceof PlanLimitError) return res.status(402).json(planLimitBody(error));
      console.error("Error sharing collection:", error);
      res.status(error.status || 500).json({ message: "Error sharing collection" });
    }
  };

  static revoke = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      const sharedWithUserId = parseInt(req.params.userId);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id) || isNaN(sharedWithUserId)) {
        return res.status(400).json({ message: "Invalid ID" });
      }
      const revoked = await CollectionService.revoke(id, userId, sharedWithUserId);
      if (!revoked) return res.status(404).json({ message: "Share not found" });
      await AuditService.record({
        actorId: userId,
        action: "collection_share_revoked",
        collectionId: id,
        targetUserId: sharedWithUserId,
        req,
      });
      res.json({ message: "Share revoked" });
    } catch (error) {
      console.error("Error revoking collection share:", error);
      res.status(500).json({ message: "Error revoking share" });
    }
  };

  // Stop seeing a collection someone shared with you
  static leave = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid collection ID" });
      const result = await CollectionService.leave(id, userId);
      await AuditService.record({
        actorId: userId,
        action: "collection_left",
        collectionId: id,
        targetUserId: result.ownerId,
        req,
      });
      const me = await User.findByPk(userId, { attributes: ["username", "fullName"] });
      await NotificationService.create(
        result.ownerId,
        `${me?.fullName || me?.username || "Someone"} left the collection "${result.name}"`,
        undefined
      );
      res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error("Error leaving collection:", error);
      res.status(500).json({ message: "Error leaving the collection" });
    }
  };
}
