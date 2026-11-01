import { RequestHandler, Router } from "express";
import isAuth from "../middlwares/isAuth";
import AttachmentController from "@src/controller/AttachmentController";

// Encrypted file attachments. The browser uploads and downloads the bytes itself, with the
// short-lived links these return; the API never handles file contents.
const router = Router();

router.use(isAuth);
router.get("/usage", AttachmentController.usage as RequestHandler);
router.get("/note/:noteId", AttachmentController.list as RequestHandler);
router.post("/note/:noteId", AttachmentController.reserve as RequestHandler);
router.post("/:id/done", AttachmentController.complete as RequestHandler);
router.get("/:id/download", AttachmentController.download as RequestHandler);
router.delete("/:id", AttachmentController.remove as RequestHandler);

export default router;
