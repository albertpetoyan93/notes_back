import { NextFunction, Request, Response, Router } from "express";
import { QueryTypes } from "sequelize";
import sequelize from "@src/configs/DB/sequelize";
import isAuth from "@src/middlwares/isAuth";

// Per-user settings encrypted in the browser with the user key (users."sealedSettings").
// The server stores an opaque token and can't read it. First use: dismissed breach alerts.
// Not on the User model on purpose, so it never rides along in other user responses.
const router = Router();
const MAX = 64 * 1024;
// encryptJson output: "e2e1.<iv>.<ciphertext>", URL-safe base64 parts.
const TOKEN = /^e2e1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type AuthRequest = Request & { user?: { userId: number } };

router.get("/", isAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await sequelize.query<{ sealedSettings: string | null }>(
      `SELECT "sealedSettings" FROM "users" WHERE "id" = :id`,
      { replacements: { id: req.user!.userId }, type: QueryTypes.SELECT }
    );
    res.json({ sealedSettings: rows[0]?.sealedSettings ?? null });
  } catch (e) {
    next(e);
  }
});

router.put("/", isAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const value = req.body?.sealedSettings;
    if (value !== null && (typeof value !== "string" || value.length > MAX || !TOKEN.test(value))) {
      res.status(400).json({ message: "sealedSettings must be an encrypted token (max 64 KB) or null." });
      return;
    }
    await sequelize.query(`UPDATE "users" SET "sealedSettings" = :value WHERE "id" = :id`, {
      replacements: { id: req.user!.userId, value },
    });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
