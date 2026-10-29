import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import User from "../models/User";
import AuditService from "../services/AuditService";
import E2EAccountService, { E2EError } from "../services/E2EAccountService";
import EmailService from "../services/EmailService";

type AuthedRequest = Request & { user?: { id: number; sessionId?: number } };

const fail = (error: unknown, res: Response, next: NextFunction) => {
  if (error instanceof E2EError) {
    res.status(error.status).send({ message: error.message });
    return;
  }
  next(error);
};

const signedInUser = async (req: AuthedRequest, res: Response) => {
  const user = req.user?.id ? await User.findByPk(req.user.id) : null;
  if (!user) res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
  return user;
};

// Told by email, because a master password change or a recovery is the kind
// of thing a person must notice if it wasn't them.
const tell = (user: User, what: string) =>
  EmailService.sendSecurityNotice({ to: user.email, what }).catch(() => undefined);

export default class E2EController {
  /** Public. Key settings for signing in; `e2e: false` for everyone else. */
  static prelogin = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.send(await E2EAccountService.prelogin(String(req.body?.email || "")));
    } catch (error) {
      fail(error, res, next);
    }
  };

  static keys = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      res.send({ keys: E2EAccountService.bundle(user) });
    } catch (error) {
      fail(error, res, next);
    }
  };

  static enable = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      await E2EAccountService.enable(user, req.body);
      await AuditService.record({ actorId: user.id, action: "e2e_enabled", req });
      tell(user, "End-to-end encryption was turned on. Your password is now your master password.");
      res.send({ keys: E2EAccountService.bundle(user) });
    } catch (error) {
      fail(error, res, next);
    }
  };

  static changeMasterPassword = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      await E2EAccountService.changeMasterPassword(user, req.user?.sessionId, req.body);
      await AuditService.record({ actorId: user.id, action: "master_password_changed", req });
      tell(user, "Your master password was changed. Other devices were signed out.");
      res.send({ keys: E2EAccountService.bundle(user) });
    } catch (error) {
      fail(error, res, next);
    }
  };

  static replaceRecoveryKey = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const user = await signedInUser(req, res);
      if (!user) return;
      await E2EAccountService.replaceRecoveryKey(user, req.body);
      await AuditService.record({ actorId: user.id, action: "recovery_key_replaced", req });
      tell(user, "A new recovery key was made. The old one no longer works.");
      res.send({ ok: true });
    } catch (error) {
      fail(error, res, next);
    }
  };

  /** Public, rate limited. Gives the recovery copy only to someone holding the recovery key. */
  static recoveryStart = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.send(await E2EAccountService.recoveryStart(req.body?.email, req.body?.recoveryAuth));
    } catch (error) {
      fail(error, res, next);
    }
  };

  static recoveryComplete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await E2EAccountService.recoveryComplete(req.body);
      await AuditService.record({ actorId: user.id, action: "recovered_with_key", req });
      tell(user, "Your master password was reset with your recovery key. All devices were signed out.");
      res.send({ ok: true });
    } catch (error) {
      fail(error, res, next);
    }
  };
}
