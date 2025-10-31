import { Response } from "express";
import NoteService from "../services/NoteService";

export default class NoteController {
  static getNotes = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const { category, project, search, isFavorite } = req.query;

      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const notes = await NoteService.getNotes(userId, {
        category,
        project,
        search,
        isFavorite: isFavorite === "true",
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
      } = req.body;

      const note = await NoteService.createNote(userId, {
        title,
        content,
        category,
        project,
        tags,
        isFavorite,
        isEncrypted,
      });

      res.status(201).json(note);
    } catch (error) {
      console.error("Error creating note:", error);
      res.status(500).json({ message: "Error creating note" });
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
      } = req.body;

      const note = await NoteService.updateNote(noteId, userId, {
        title,
        content,
        category,
        project,
        tags,
        isFavorite,
        isEncrypted,
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

      res.json({ message: "Note deleted successfully" });
    } catch (error) {
      console.error("Error deleting note:", error);
      res.status(500).json({ message: "Error deleting note" });
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
}
