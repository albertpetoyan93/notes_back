import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import User from "../models/User";
import AuditService from "../services/AuditService";
import PasskeyService, { PasskeyError } from "../services/PasskeyService";
import SessionService, {
  AUTO_LOCK_CHOICES,
  EXTENSION_AUTO_LOCK_CHOICES,
} from "../services/SessionService";
import E2EAccountService from "../services/E2EAccountService";

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
      // Master-password accounts prove it with the derived sign-in key.
      const secret = String((user.e2eEnabled ? req.body?.authKey : req.body?.password) || "");
      if (!secret || !(await user.comparePassword(secret))) {
        await AuditService.record({ actorId: user.id, action: "unlock_failed", req });
        res.status(HttpStatusCodes.UNAUTHORIZED).send({
          message: user.e2eEnabled ? "That master password isn't right." : "That password isn't right.",
        });
        return;
      }
      await SessionService.unlock(sessionId, user.id);
      await AuditService.record({
        actorId: user.id,
        action: "session_unlocked",
        details: { method: "password" },
        req,
      });
      // The locked keys, so the browser can open the vault again.
      res.status(HttpStatusCodes.OK).send({ locked: false, keys: E2EAccountService.bundle(user) });
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
      // End-to-end accounts: a passkey that can't open the vault doesn't
      // unlock the session either, so the server and the browser agree.
      if (user.e2eEnabled && !passkey.prfUserKey) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          message:
            "This passkey can't open your vault yet. Use your master password, then turn on unlock for it in Security settings.",
        });
        return;
      }
      await SessionService.unlock(sessionId, id);
      await AuditService.record({
        actorId: id,
        action: "session_unlocked",
        details: { method: "passkey", passkeyName: passkey.name },
        req,
      });
      res.status(HttpStatusCodes.OK).send({
        locked: false,
        ...(user.e2eEnabled
          ? { keys: E2EAccountService.bundle(user), passkeyUserKey: passkey.prfUserKey || null }
          : {}),
      });
    } catch (e) {
      if (e instanceof PasskeyError) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  /** Change how long the vault app and/or the extension may sit idle before they lock. */
  static settings = async (req: LockRequest, res: Response, next: NextFunction) => {
    try {
      const hasVault = Object.prototype.hasOwnProperty.call(req.body || {}, "autoLockMinutes");
      const hasExtension = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "extensionAutoLockMinutes"
      );
      if (!hasVault && !hasExtension) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          message: "Send autoLockMinutes and/or extensionAutoLockMinutes.",
        });
        return;
      }

      const vaultMinutes = hasVault ? Number(req.body.autoLockMinutes) : undefined;
      const extensionMinutes = hasExtension ? Number(req.body.extensionAutoLockMinutes) : undefined;
      const invalid =
        (hasVault && !AUTO_LOCK_CHOICES.includes(vaultMinutes as number)) ||
        (hasExtension && !EXTENSION_AUTO_LOCK_CHOICES.includes(extensionMinutes as number));
      if (invalid) {
        const choices =
          hasExtension && !hasVault ? EXTENSION_AUTO_LOCK_CHOICES : AUTO_LOCK_CHOICES;
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          message: `Choose one of: ${choices.join(", ")} minutes (0 = never).`,
        });
        return;
      }

      const user = req.user?.id ? await User.findByPk(req.user.id) : null;
      if (!user) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Sign in again" });
        return;
      }

      const patch: { autoLockMinutes?: number; extensionAutoLockMinutes?: number } = {};
      if (hasVault) patch.autoLockMinutes = vaultMinutes;
      if (hasExtension) patch.extensionAutoLockMinutes = extensionMinutes;
      await user.update(patch);

      await AuditService.record({
        actorId: user.id,
        action: "auto_lock_changed",
        details: {
          ...(hasVault ? { minutes: vaultMinutes } : {}),
          ...(hasExtension ? { extensionMinutes } : {}),
        },
        req,
      });
      res.status(HttpStatusCodes.OK).send({
        autoLockMinutes: user.autoLockMinutes,
        extensionAutoLockMinutes: user.extensionAutoLockMinutes,
      });
    } catch (e) {
      next(e);
    }
  };
}
