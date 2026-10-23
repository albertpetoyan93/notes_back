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

router.get("/autofill", NoteController.autofill as RequestHandler);
// Passkeys for other websites: the browser extension only.
router.get("/passkeys", NoteController.passkeys as RequestHandler);
router.post("/passkeys", NoteController.savePasskey as RequestHandler);
// Leaked-password check: the browser checks, the API keeps the results.
router.get("/health/breaches", NoteController.breachStatus as RequestHandler);
router.post("/health/breaches", NoteController.saveBreachResults as RequestHandler);
router.get("/export", NoteController.exportNotes as RequestHandler);
router.post("/import", NoteController.importNotes as RequestHandler);
router.delete("/trash", NoteController.emptyTrash as RequestHandler);
router.post("/bulk", NoteController.bulkUpdate as RequestHandler);

// Share management (before /:id to avoid conflicts)
router.get("/:id/shares", NoteController.getNoteShares as RequestHandler);
router.post("/:id/share", NoteController.shareNote as RequestHandler);
router.delete(
  "/:id/share/:userId",
  NoteController.revokeShare as RequestHandler
);

// Leave an item someone shared with you; history; secret reveal/copy events
router.post("/:id/leave", NoteController.leaveShare as RequestHandler);
router.get("/:id/activity", NoteController.activity as RequestHandler);
// Version history: list, open one, put one back.
router.get("/:id/versions", NoteController.listVersions as RequestHandler);
router.get("/:id/versions/:versionId", NoteController.getVersion as RequestHandler);
router.post("/:id/versions/:versionId/restore", NoteController.restoreVersion as RequestHandler);
router.get("/:id/access", NoteController.accessList as RequestHandler);
router.post("/:id/events", NoteController.recordEvent as RequestHandler);

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
