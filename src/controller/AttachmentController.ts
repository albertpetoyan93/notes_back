import { Response } from "express";
import AttachmentService, { AttachmentError } from "../services/AttachmentService";
import AuditService from "../services/AuditService";
import { PlanLimitError, planLimitBody } from "../services/EntitlementService";
import StorageService from "../services/StorageService";

async function respond(res: Response, fallback: string, run: () => Promise<unknown>) {
  try {
    res.json((await run()) ?? { ok: true });
  } catch (error: any) {
    if (error instanceof AttachmentError) return res.status(error.status).json({ message: error.message });
    if (error instanceof PlanLimitError) return res.status(error.status).json(planLimitBody(error));
    console.error(fallback, error);
    res.status(500).json({ message: fallback });
  }
}

const noteId = (req: any) => Number.parseInt(String(req.params.noteId), 10);

/** Encrypted file attachments (plans/vault-features.md, phase C). */
export default class AttachmentController {
  static usage = async (req: any, res: Response) =>
    respond(res, "Could not load storage", () => AttachmentService.personalUsage(req.user.id));

  static list = async (req: any, res: Response) =>
    respond(res, "Could not load files", () => AttachmentService.list(noteId(req), req.user.id));

  /** Body: { size } (encrypted size). */
  static reserve = async (req: any, res: Response) =>
    respond(res, "Could not start the upload", () => AttachmentService.reserve(noteId(req), req.user.id, req.body?.size));

  /** Body: { encMeta, wrappedKey }. */
  static complete = async (req: any, res: Response) =>
    respond(res, "Could not save the file", async () => {
      const { file, noteId: id } = await AttachmentService.complete(String(req.params.id), req.user.id, req.body || {});
      await AuditService.record({ actorId: req.user.id, action: "attachment_added", noteId: id, details: { size: file.size }, req });
      return file;
    });

  static download = async (req: any, res: Response) =>
    respond(res, "Could not open the file", async () => {
      const result = await AttachmentService.download(String(req.params.id), req.user.id);
      await AuditService.record({ actorId: req.user.id, action: "attachment_downloaded", noteId: result.noteId, details: {}, req });
      return result.download;
    });

  static remove = async (req: any, res: Response) =>
    respond(res, "Could not delete the file", async () => {
      const result = await AttachmentService.remove(String(req.params.id), req.user.id);
      await AuditService.record({ actorId: req.user.id, action: "attachment_deleted", noteId: result.noteId, details: {}, req });
    });

  /* Local storage (development): the signed links point here. ----------------------- */

  /** Streamed to disk, never held in memory. */
  static localPut = async (req: any, res: Response) => {
    const allowed = StorageService.checkLocal("put", String(req.params.key), req.query || {});
    if (!allowed || req.query.op !== "put") return res.status(403).json({ message: "Link expired" });
    // A declared size that doesn't match is refused before reading anything.
    const declared = req.headers["content-length"];
    if (allowed.size !== null && declared !== undefined && Number(declared) !== allowed.size) {
      return res.status(400).json({ message: "Wrong size" });
    }
    try {
      await StorageService.writeLocalStream(allowed.file, req, allowed.size);
      res.status(200).end();
    } catch (error: any) {
      if (error?.message === "wrong-size" || error?.message === "too-large") {
        return res.status(400).json({ message: "Wrong size" });
      }
      console.error("Could not store an upload", error);
      if (!res.headersSent) res.status(500).json({ message: "Could not store the file" });
    }
  };

  static localGet = async (req: any, res: Response) => {
    const allowed = StorageService.checkLocal("get", String(req.params.key), req.query || {});
    if (!allowed || req.query.op !== "get") return res.status(403).json({ message: "Link expired" });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(allowed.file, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  };
}
