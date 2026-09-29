import { Router, RequestHandler } from "express";
import isAuth from "../middlwares/isAuth";
import CollectionController from "../controller/CollectionController";

const router = Router();

router.use(isAuth);
router.get("/", CollectionController.list as RequestHandler);
router.post("/", CollectionController.create as RequestHandler);
router.get("/:id/available-notes", CollectionController.availableNotes as RequestHandler);
router.post("/:id/notes", CollectionController.addNotes as RequestHandler);
router.delete("/:id/notes/:noteId", CollectionController.removeNote as RequestHandler);
router.get("/:id/shares", CollectionController.shares as RequestHandler);
router.post("/:id/share", CollectionController.share as RequestHandler);
router.delete("/:id/share/:userId", CollectionController.revoke as RequestHandler);
router.put("/:id", CollectionController.rename as RequestHandler);
router.delete("/:id", CollectionController.remove as RequestHandler);

export default router;
