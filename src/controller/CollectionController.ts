import { Response } from "express";
import CollectionService from "../services/CollectionService";

const parseExpiry = (expiresIn: unknown) => {
  if (!expiresIn || expiresIn === "never") return null;
  const days = Number(expiresIn);
  if (![1, 7, 30].includes(days)) return undefined;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
};

export default class CollectionController {
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
      const collection = await CollectionService.create(userId, req.body?.name || "");
      res.status(201).json(collection);
    } catch (error: any) {
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
      const collection = await CollectionService.rename(id, userId, req.body?.name || "");
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
      const result = await CollectionService.addNotes(id, userId, noteIds);
      res.json(result);
    } catch (error: any) {
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
        expiresAt
      );
      if (!result.shared.length && result.failed.length) {
        return res.status(400).json({
          message: result.failed.map((item) => item.message).join("; "),
          shared: result.shared,
          failed: result.failed,
        });
      }
      res.status(201).json(result);
    } catch (error: any) {
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
      res.json({ message: "Share revoked" });
    } catch (error) {
      console.error("Error revoking collection share:", error);
      res.status(500).json({ message: "Error revoking share" });
    }
  };
}
