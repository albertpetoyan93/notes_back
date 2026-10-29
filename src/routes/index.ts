import { Router } from "express";
import auth from "./auth";
import notes from "./notes";
import notifications from "./notifications";
import collections from "./collections";
import companies from "./companies";
import secrets from "./secrets";
import billing from "./billing";
import admin from "./admin";

const router = Router();

router.use("/auth", auth);
router.use("/notes", notes);
router.use("/notifications", notifications);
router.use("/collections", collections);
router.use("/companies", companies);
router.use("/secrets", secrets);
router.use("/billing", billing);
router.use("/admin", admin);

export default router;
