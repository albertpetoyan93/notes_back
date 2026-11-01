import AdminAuthController from "@src/controller/AdminAuthController";
import isStaff from "@src/middlwares/isStaff";
import { Router } from "express";
import { authLimiter, lookupLimiter, twoFactorLimiter } from "./auth";

// Staff sign-in, mounted under /api/admin/auth. Shares the vault's sign-in limits.
const router = Router();

router.post("/login", authLimiter, AdminAuthController.login);
router.post("/2fa", twoFactorLimiter, AdminAuthController.verifyTwoFactor);
router.post("/passkey/options", lookupLimiter, AdminAuthController.passkeyOptions);
router.post("/passkey", authLimiter, AdminAuthController.passkeyLogin);
router.post("/refresh", AdminAuthController.refresh);
router.post("/logout", AdminAuthController.logout);
router.get("/me", isStaff, AdminAuthController.me as any);

export default router;
