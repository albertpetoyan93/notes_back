import { Router } from "express";
import auth from "./auth";
import notes from "./notes";
import notifications from "./notifications";
import collections from "./collections";

const router = Router();

router.use("/auth", auth);
router.use("/notes", notes);
router.use("/notifications", notifications);
router.use("/collections", collections);

export default router;
