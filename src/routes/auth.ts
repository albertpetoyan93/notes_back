import AuthController from "@src/controller/AuthController";
import isAuth from "@src/middlwares/isAuth";
import rateLimit from "express-rate-limit";
import { Router } from "express";

const router = Router();

// Tighter than authLimiter: a 6-digit code is the only thing being guessed.
const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Try again in 15 minutes." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Try again in 15 minutes." },
});

router.post("/login", authLimiter, AuthController.login);
router.post("/extension/login", authLimiter, AuthController.extensionLogin);
router.post(
  "/extension/connect",
  isAuth,
  AuthController.extensionConnect as any
);
router.post("/extension/refresh", AuthController.extensionRefresh);
router.post("/extension/logout", AuthController.extensionLogout);
router.post("/register", authLimiter, AuthController.register);
router.post("/forgot-password", authLimiter, AuthController.forgotPassword);
router.post("/reset-password", authLimiter, AuthController.resetPassword);
router.post("/refresh", AuthController.refresh);
router.post("/logout", AuthController.logout);
router.post("/2fa/verify", twoFactorLimiter, AuthController.verifyTwoFactor);
router.post(
  "/extension/2fa/verify",
  twoFactorLimiter,
  AuthController.extensionVerifyTwoFactor
);
router.get("/2fa/status", isAuth, AuthController.twoFactorStatus as any);
router.post("/2fa/setup", isAuth, AuthController.twoFactorSetup as any);
router.post(
  "/2fa/enable",
  isAuth,
  twoFactorLimiter,
  AuthController.twoFactorEnable as any
);
router.post(
  "/2fa/disable",
  isAuth,
  twoFactorLimiter,
  AuthController.twoFactorDisable as any
);
router.post(
  "/2fa/recovery-codes",
  isAuth,
  twoFactorLimiter,
  AuthController.twoFactorRecoveryCodes as any
);
router.get("/sessions", isAuth, AuthController.listSessions as any);
router.post(
  "/sessions/revoke-others",
  isAuth,
  AuthController.revokeOtherSessions as any
);
router.delete("/sessions/:id", isAuth, AuthController.revokeSession as any);
router.get("/me", isAuth, AuthController.me as any);
router.get("/users", isAuth, AuthController.searchUsers as any);

export default router;
