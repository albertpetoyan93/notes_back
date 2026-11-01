import { RequestHandler, Router } from "express";
import AttachmentController from "@src/controller/AttachmentController";

// Local file storage for development (StorageService "local" driver). No sign-in: each
// request carries a short-lived signature for one file and one operation.
const router = Router();

router.put("/:key", AttachmentController.localPut as RequestHandler);
router.get("/:key", AttachmentController.localGet as RequestHandler);

export default router;
