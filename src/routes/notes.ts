import { Router, RequestHandler } from "express";
import isAuth from "../middlwares/isAuth";
import NoteController from "@src/controller/NoteController";

const router = Router();

// All note routes require authentication
router.use(isAuth);

// Get all notes (with optional filters)
router.get("/", NoteController.getNotes as RequestHandler);

// Get note statistics
router.get("/stats", NoteController.getNoteStats as RequestHandler);

// Get all projects
router.get("/projects", NoteController.getProjects as RequestHandler);

router.get("/export", NoteController.exportNotes as RequestHandler);
router.post("/import", NoteController.importNotes as RequestHandler);

// Share management (before /:id to avoid conflicts)
router.get("/:id/shares", NoteController.getNoteShares as RequestHandler);
router.post("/:id/share", NoteController.shareNote as RequestHandler);
router.delete(
  "/:id/share/:userId",
  NoteController.revokeShare as RequestHandler
);

// Get a single note
router.get("/:id", NoteController.getNote as RequestHandler);

// Create a new note
router.post("/", NoteController.createNote as RequestHandler);

// Update a note
router.put("/:id", NoteController.updateNote as RequestHandler);

// Restore a trashed note
router.post("/:id/favorite", NoteController.toggleFavorite as RequestHandler);
router.post("/:id/restore", NoteController.restoreNote as RequestHandler);

// Delete a note (soft delete)
router.delete("/:id", NoteController.deleteNote as RequestHandler);

export default router;
