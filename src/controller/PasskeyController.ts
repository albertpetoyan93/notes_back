import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import { AuthRequest } from "@src/types";
import User from "@src/models/User";
import AuthService from "@src/services/AuthService";
import AuditService from "@src/services/AuditService";
import PasskeyService, { PasskeyError } from "@src/services/PasskeyService";
import E2EAccountService from "@src/services/E2EAccountService";
import { setAuthCookies } from "@src/util/authCookies";
import { publicUser, sessionMeta } from "./AuthController";

function failure(e: unknown, res: Response, next: NextFunction) {
  if (e instanceof PasskeyError) {
    res.status(HttpStatusCodes.BAD_REQUEST).send({ message: e.message });
  } else {
    next(e);
  }
}

async function signedInUser(req: AuthRequest, res: Response) {
  const user = req.user?.id ? await User.findByPk(req.user.id) : null;
  if (!user) {
    res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
  }
  return user;
}

export default class PasskeyController {
  static list = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      res.status(HttpStatusCodes.OK).send(await PasskeyService.list(user.id));
    } catch (e) {
      next(e);
    }
  };

  /**
   * Adding a passkey asks for the password again: otherwise a stolen session
   * could add its own passkey and keep access after a password change.
   */
  static registrationOptions = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      if (!(await user.comparePassword(String(req.body?.password || "")))) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({ message: "Wrong password." });
        return;
      }
      res.status(HttpStatusCodes.OK).send(await PasskeyService.registrationOptions(user));
    } catch (e) {
      failure(e, res, next);
    }
  };

  static register = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      const passkey = await PasskeyService.register(
        user,
        req.body?.challengeToken,
        req.body?.response,
        req.body?.name
      );
      await AuditService.record({
        actorId: user.id,
        action: "passkey_added",
        details: { name: passkey.name },
        req: req as unknown as Request,
      });
      res.status(HttpStatusCodes.CREATED).send(passkey);
    } catch (e) {
      failure(e, res, next);
    }
  };

  static rename = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      res
        .status(HttpStatusCodes.OK)
        .send(await PasskeyService.rename(user.id, Number(req.params.id), req.body?.name));
    } catch (e) {
      failure(e, res, next);
    }
  };

  static remove = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      const passkey = await PasskeyService.remove(user.id, Number(req.params.id));
      await AuditService.record({
        actorId: user.id,
        action: "passkey_removed",
        details: { name: passkey.name },
        req: req as unknown as Request,
      });
      res.status(HttpStatusCodes.OK).send({ ok: true });
    } catch (e) {
      failure(e, res, next);
    }
  };

  /** Let one of your passkeys open the vault (end-to-end accounts, PRF). */
  static saveUnlockKey = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
        return;
      }
      const passkey = await PasskeyService.saveUnlockKey(
        userId,
        req.body?.challengeToken,
        req.body?.response,
        req.body?.prfUserKey
      );
      await AuditService.record({
        actorId: userId,
        action: "passkey_unlock_enabled",
        details: { passkeyName: passkey.name },
        req: req as unknown as Request,
      });
      res.status(HttpStatusCodes.OK).send(passkey);
    } catch (e) {
      if (e instanceof PasskeyError) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  static loginOptions = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(HttpStatusCodes.OK).send(await PasskeyService.authenticationOptions());
    } catch (e) {
      failure(e, res, next);
    }
  };

  /**
   * A passkey is both factors at once (the device, and the face, fingerprint or PIN
   * that unlocks it), so no 2FA code is asked after it.
   */
  static login = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user, passkey } = await PasskeyService.authenticate(
        req.body?.challengeToken,
        req.body?.response
      );
      const session = await AuthService.issueSession(user, sessionMeta(req));
      setAuthCookies(res, session.accessToken, session.refreshToken);
      await AuditService.record({
        actorId: user.id,
        action: "login",
        details: { kind: "web", passkey: true, passkeyName: passkey.name },
        req,
      });
      // End-to-end accounts: the locked keys, and this passkey's unlock copy
      // if it has one, so the browser can open the vault without the master password.
      res.status(HttpStatusCodes.OK).send({
        user: publicUser(user),
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
}
