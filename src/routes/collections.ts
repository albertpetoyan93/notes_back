import { Router, RequestHandler } from "express";
import isAuth from "../middlwares/isAuth";
import CollectionController from "../controller/CollectionController";

const router = Router();

router.use(isAuth);
router.get("/", CollectionController.list as RequestHandler);
// End-to-end keys (stage 10.4): background work for owners and admins.
router.get("/e2e/tasks", CollectionController.e2eTasks as RequestHandler);
router.post("/e2e/keys", CollectionController.e2eKeys as RequestHandler);
router.post("/e2e/names", CollectionController.e2eNames as RequestHandler);
router.post("/:id/e2e/rotate", CollectionController.e2eRotate as RequestHandler);
router.post("/", CollectionController.create as RequestHandler);
router.get("/:id/available-notes", CollectionController.availableNotes as RequestHandler);
router.post("/:id/notes", CollectionController.addNotes as RequestHandler);
router.delete("/:id/notes/:noteId", CollectionController.removeNote as RequestHandler);
router.get("/:id/shares", CollectionController.shares as RequestHandler);
router.post("/:id/share", CollectionController.share as RequestHandler);
router.delete("/:id/share/:userId", CollectionController.revoke as RequestHandler);
router.post("/:id/leave", CollectionController.leave as RequestHandler);
router.put("/:id", CollectionController.rename as RequestHandler);
router.delete("/:id", CollectionController.remove as RequestHandler);

export default router;
