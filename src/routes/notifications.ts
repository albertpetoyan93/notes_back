import { Router, RequestHandler } from "express";
import isAuth from "../middlwares/isAuth";
import NotificationController from "../controller/NotificationController";

const router = Router();

router.use(isAuth);
router.get("/", NotificationController.list as RequestHandler);
router.post("/read-all", NotificationController.markAllRead as RequestHandler);
router.post("/:id/read", NotificationController.markRead as RequestHandler);

export default router;
