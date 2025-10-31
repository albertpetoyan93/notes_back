import { Router } from "express";
import auth from "./auth";
import notes from "./notes";

const router = Router();

router.use("/auth", auth);
router.use("/notes", notes);

export default router;
