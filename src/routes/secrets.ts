import { Router } from "express";
import rateLimit from "express-rate-limit";
import SecretLinkController from "@src/controller/SecretLinkController";
import isAuth from "@src/middlwares/isAuth";

// One-time secret links: signed-in people create them; anyone with the link opens it.
const router = Router();

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Try again in 15 minutes." },
});

router.post("/", isAuth, SecretLinkController.create as any);
router.get("/", isAuth, SecretLinkController.list as any);
router.delete("/:id", isAuth, SecretLinkController.revoke as any);

router.get("/:id/meta", publicLimiter, SecretLinkController.peek);
router.post("/:id/open", publicLimiter, SecretLinkController.open);

export default router;
