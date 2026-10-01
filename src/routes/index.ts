import { Router } from "express";
import auth from "./auth";
import notes from "./notes";
import notifications from "./notifications";
import collections from "./collections";
import companies from "./companies";

const router = Router();

router.use("/auth", auth);
router.use("/notes", notes);
router.use("/notifications", notifications);
router.use("/collections", collections);
router.use("/companies", companies);

export default router;
