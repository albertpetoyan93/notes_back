import { Router } from "express";
import auth from "./auth";
import notes from "./notes";
import notifications from "./notifications";
import collections from "./collections";
import companies from "./companies";
import secrets from "./secrets";
import billing from "./billing";
import admin from "./admin";
import emergency from "./emergency";
import attachments from "./attachments";
import files from "./files";

const router = Router();

router.use("/auth", auth);
router.use("/notes", notes);
router.use("/notifications", notifications);
router.use("/collections", collections);
router.use("/companies", companies);
router.use("/secrets", secrets);
router.use("/billing", billing);
router.use("/admin", admin);
router.use("/emergency", emergency);
router.use("/attachments", attachments);
router.use("/files", files);

export default router;
