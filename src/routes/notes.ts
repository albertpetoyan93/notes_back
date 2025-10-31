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

// Get a single note
router.get("/:id", NoteController.getNote as RequestHandler);

// Create a new note
router.post("/", NoteController.createNote as RequestHandler);

// Update a note
router.put("/:id", NoteController.updateNote as RequestHandler);

// Delete a note
router.delete("/:id", NoteController.deleteNote as RequestHandler);

export default router;
