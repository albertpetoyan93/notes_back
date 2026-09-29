import AuthController from "@src/controller/AuthController";
import isAuth from "@src/middlwares/isAuth";
import rateLimit from "express-rate-limit";
import { Router } from "express";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Try again in 15 minutes." },
});

router.post("/login", authLimiter, AuthController.login);
router.post("/register", authLimiter, AuthController.register);
router.get("/me", isAuth, AuthController.me as any);
router.get("/users", isAuth, AuthController.searchUsers as any);

export default router;
