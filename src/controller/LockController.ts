import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import User from "../models/User";
import AuditService from "../services/AuditService";
import PasskeyService, { PasskeyError } from "../services/PasskeyService";
import SessionService, { AUTO_LOCK_CHOICES } from "../services/SessionService";

type LockRequest = Request & {
  user?: { id: number; sessionId?: number; locked?: boolean };
};

// Auto-lock: the vault app locks the session after idle time; unlocking needs
// the account password or one of the account's passkeys (no 2FA code: the
// session already passed it).
export default class LockController {
  /** The person used the page (mouse, keyboard, touch). Keeps the session unlocked. */
  static active = async (req: LockRequest, res: Response, next: NextFunction) => {
    try {
      const { id, sessionId } = req.user || ({} as LockRequest["user"] & object);
      if (id && sessionId) await SessionService.touch(sessionId, id);
      res.status(HttpStatusCodes.NO_CONTENT).send();
    } catch (e) {
      next(e);
    }
  };

  static lock = async (req: LockRequest, res: Response, next: NextFunction) => {
    try {
      const { id, sessionId } = req.user || ({} as LockRequest["user"] & object);
      if (id && sessionId) await SessionService.lock(sessionId, id);
      res.status(HttpStatusCodes.OK).send({ locked: true });
    } catch (e) {
      next(e);
    }
  };

  static unlock = async (req: LockRequest, res: Response, next: NextFunction) => {
    try {
      const { id, sessionId } = req.user || ({} as LockRequest["user"] & object);
      const user = id ? await User.findByPk(id) : null;
      if (!user || !sessionId) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Sign in again" });
        return;
      }
      const password = String(req.body?.password || "");
      if (!password || !(await user.comparePassword(password))) {
        await AuditService.record({ actorId: user.id, action: "unlock_failed", req });
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "That password isn't right." });
        return;
      }
      await SessionService.unlock(sessionId, user.id);
      await AuditService.record({
        actorId: user.id,
        action: "session_unlocked",
        details: { method: "password" },
        req,
      });
      res.status(HttpStatusCodes.OK).send({ locked: false });
    } catch (e) {
      next(e);
    }
  };

  static passkeyOptions = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(HttpStatusCodes.OK).send(await PasskeyService.authenticationOptions());
    } catch (e) {
      next(e);
    }
  };

  static unlockWithPasskey = async (req: LockRequest, res: Response, next: NextFunction) => {
    try {
      const { id, sessionId } = req.user || ({} as LockRequest["user"] & object);
      if (!id || !sessionId) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Sign in again" });
        return;
      }
      const { user, passkey } = await PasskeyService.authenticate(
        req.body?.challengeToken,
        req.body?.response
      );
      if (user.id !== id) {
        await AuditService.record({ actorId: id, action: "unlock_failed", req });
        res
          .status(HttpStatusCodes.UNAUTHORIZED)
          .send({ message: "That passkey belongs to another account." });
        return;
      }
      await SessionService.unlock(sessionId, id);
      await AuditService.record({
        actorId: id,
        action: "session_unlocked",
        details: { method: "passkey", passkeyName: passkey.name },
        req,
      });
      res.status(HttpStatusCodes.OK).send({ locked: false });
    } catch (e) {
      if (e instanceof PasskeyError) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  /** Change how long the vault may sit idle before it locks. */
  static settings = async (req: LockRequest, res: Response, next: NextFunction) => {
    try {
      const minutes = Number(req.body?.autoLockMinutes);
      if (!AUTO_LOCK_CHOICES.includes(minutes)) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          message: `Choose one of: ${AUTO_LOCK_CHOICES.join(", ")} minutes (0 = never).`,
        });
        return;
      }
      const user = req.user?.id ? await User.findByPk(req.user.id) : null;
      if (!user) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Sign in again" });
        return;
      }
      await user.update({ autoLockMinutes: minutes });
      await AuditService.record({
        actorId: user.id,
        action: "auto_lock_changed",
        details: { minutes },
        req,
      });
      res.status(HttpStatusCodes.OK).send({ autoLockMinutes: minutes });
    } catch (e) {
      next(e);
    }
  };
}
