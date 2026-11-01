import { NextFunction, Request, Response } from "express";
import logger from "jet-logger";
import HttpStatusCodes from "../common/HttpStatusCodes";
import { toStaffMe } from "@src/admin/dto";
import type { StaffRole } from "@src/models/AdminStaff";
import User from "@src/models/User";
import AuthService, { E2E_REQUIRED } from "@src/services/AuthService";
import AdminActionService from "@src/services/admin/AdminActionService";
import AuditService from "@src/services/AuditService";
import StaffService from "@src/services/admin/StaffService";
import { isAdminEmail } from "@src/services/DiscountService";
import PasskeyService, { PasskeyError } from "@src/services/PasskeyService";
import SessionService, { RefreshError } from "@src/services/SessionService";
import TwoFactorService from "@src/services/TwoFactorService";
import { StaffRequest } from "@src/types";
import { ADMIN_REFRESH_COOKIE, clearAdminCookies, setAdminCookies } from "@src/util/adminCookies";
import { sessionMeta } from "./AuthController";

const CHALLENGE_EXPIRED = "Sign-in expired. Enter your password again.";

function suspended(res: Response) {
  res.status(HttpStatusCodes.FORBIDDEN).send({
    code: "suspended",
    message: "This account is suspended. Contact support.",
  });
}

function notStaff(res: Response) {
  res.status(HttpStatusCodes.FORBIDDEN).send({ code: "not_staff", message: "Not a staff member" });
}

/**
 * Called after the 401 is sent, so the answer takes as long for staff as for
 * anyone else. The owner sees the attempt in their own activity log; staff
 * accounts also get an admin log row. Never throws.
 */
async function recordFailedSignIn(req: Request, user: User | null, step: "password" | "code") {
  if (!user) return;
  try {
    await AuditService.record({
      actorId: user.id,
      action: step === "password" ? "login_failed" : "two_factor_failed",
      details: { kind: "admin" },
      req,
    });
  } catch (error) {
    logger.err(error, true);
  }
  try {
    const role = isAdminEmail(user.email) ? "admin" : await StaffService.roleOf(user.id);
    if (!role) return;
    await AdminActionService.record({
      staff: { userId: user.id, email: user.email, role },
      action: "admin_sign_in_failed",
      details: { step },
      req,
    });
  } catch (error) {
    logger.err(error, true);
  }
}

async function recordFailedPassword(req: Request) {
  try {
    const typed = String(req.body?.email || "").trim();
    const user = typed ? await User.findOne({ where: { email: typed }, attributes: ["id", "email"] }) : null;
    await recordFailedSignIn(req, user, "password");
  } catch (error) {
    logger.err(error, true);
  }
}

/**
 * The tokens only leave the server once admin_sign_in is written: a staff
 * sign-in that can't be logged is undone instead.
 */
async function signIn(req: Request, res: Response, user: User, role: StaffRole, details: Record<string, string | boolean>) {
  const session = await SessionService.create(user.id, "admin", sessionMeta(req));
  try {
    await AdminActionService.record({
      staff: { userId: user.id, email: user.email, role },
      action: "admin_sign_in",
      details,
      req,
    });
  } catch (error) {
    try {
      await SessionService.revoke(user.id, session.sessionId);
    } catch (revokeError) {
      logger.err(revokeError, true);
    }
    throw error;
  }
  setAdminCookies(res, session.accessToken, session.refreshToken);
  res.status(HttpStatusCodes.OK).send({ staff: toStaffMe(user, role) });
}

export default class AdminAuthController {
  /** Checks the password; staff then need a TOTP code or a passkey. Never creates a session. */
  static login = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, authKey } = req.body;

      const user = await AuthService.login({ email, password, authKey });
      if (user.suspendedAt) {
        suspended(res);
        return;
      }
      const role = await StaffService.roleOf(user.id);
      if (!role) {
        notStaff(res);
        return;
      }
      if (user.twoFactorEnabled) {
        res.status(HttpStatusCodes.OK).send({
          twoFactorRequired: true,
          challengeToken: AuthService.createLoginChallenge(user, "admin"),
        });
        return;
      }
      // A password alone never signs staff in.
      if ((await PasskeyService.count(user.id)) > 0) {
        res.status(HttpStatusCodes.FORBIDDEN).send({
          code: "use_passkey",
          message: "Sign in with your passkey.",
        });
        return;
      }
      res.status(HttpStatusCodes.FORBIDDEN).send({
        code: "needs_second_factor",
        message: "Turn on two-factor authentication or add a passkey in the 2keevo app first.",
      });
    } catch (e: any) {
      if (e.message === E2E_REQUIRED) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          code: "e2e_required",
          message: "This account uses a master password. Reload the page to sign in.",
        });
      } else if (e.message === "Invalid credentials") {
        // Same answer as the vault, staff or not; logged after it is sent.
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
        void recordFailedPassword(req);
      } else {
        next(e);
      }
    }
  };

  static verifyTwoFactor = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Only a challenge from the admin /login: a vault challenge is refused here.
      const user = await AuthService.readLoginChallenge(req.body?.challengeToken, "admin");
      if (user.suspendedAt) {
        suspended(res);
        return;
      }
      const role = await StaffService.roleOf(user.id);
      if (!role) {
        notStaff(res);
        return;
      }
      if (!(await TwoFactorService.verify(user.id, req.body?.code))) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "That code is not valid." });
        void recordFailedSignIn(req, user, "code");
        return;
      }
      await signIn(req, res, user, role, { method: "totp" });
    } catch (e: any) {
      if (e.message === CHALLENGE_EXPIRED) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ code: "challenge_expired", message: e.message });
      } else {
        next(e);
      }
    }
  };

  static passkeyOptions = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(HttpStatusCodes.OK).send(await PasskeyService.authenticationOptions());
    } catch (e) {
      if (e instanceof PasskeyError) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  /** A passkey is both factors (PasskeyService requires user verification). */
  static passkeyLogin = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user, passkey } = await PasskeyService.authenticate(req.body?.challengeToken, req.body?.response);
      if (user.suspendedAt) {
        suspended(res);
        return;
      }
      const role = await StaffService.roleOf(user.id);
      if (!role) {
        notStaff(res);
        return;
      }
      await signIn(req, res, user, role, { method: "passkey", passkeyName: passkey.name });
    } catch (e) {
      if (e instanceof PasskeyError) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  static refresh = async (req: Request, res: Response) => {
    try {
      const session = await SessionService.rotate(req.cookies?.[ADMIN_REFRESH_COOKIE], "admin", sessionMeta(req));
      setAdminCookies(res, session.accessToken, session.refreshToken);
      res.status(HttpStatusCodes.OK).send({ ok: true });
    } catch (error) {
      const reason = error instanceof RefreshError ? error.reason : "error";
      logger.warn(`Admin refresh refused: ${reason}`);
      clearAdminCookies(res);
      res.status(HttpStatusCodes.UNAUTHORIZED).send({ code: "session_expired", message: "Staff session expired" });
    }
  };

  static logout = async (req: Request, res: Response) => {
    const token = req.cookies?.[ADMIN_REFRESH_COOKIE];
    // Signing out never fails, even if the session is already gone.
    try {
      if (token) await SessionService.revokeByToken(token, "admin");
    } catch (error) {
      logger.err(error, true);
    }
    clearAdminCookies(res);
    res.status(HttpStatusCodes.OK).send({ ok: true });
  };

  static me = async (req: StaffRequest, res: Response, next: NextFunction) => {
    try {
      const staff = req.staff;
      const user = staff
        ? await User.findByPk(staff.userId, { attributes: ["id", "email", "username", "fullName"] })
        : null;
      if (!staff || !user) {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ code: "session_expired", message: "Staff session expired" });
        return;
      }
      res.status(HttpStatusCodes.OK).send({ staff: toStaffMe(user, staff.role) });
    } catch (e) {
      next(e);
    }
  };
}
