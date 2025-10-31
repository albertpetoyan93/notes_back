import AuthController from "@src/controller/AuthController";
import isAuth from "@src/middlwares/isAuth";
import { Router } from "express";

const router = Router();

router.post("/login", AuthController.login);
router.post("/register", AuthController.register);
router.get("/me", isAuth, AuthController.me as any);

export default router;
