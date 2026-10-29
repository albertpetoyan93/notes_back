import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import AuthService, { E2E_REQUIRED, MASTER_RESET_REFUSED } from "../services/AuthService";
import { AuthRequest } from "@src/types";
import UserService from "@src/services/UserService";
import { clearAuthCookies, setAuthCookies } from "@src/util/authCookies";
import User from "@src/models/User";
import SessionService, { RefreshError, SessionMeta } from "@src/services/SessionService";
import TwoFactorService, { TwoFactorError } from "@src/services/TwoFactorService";
import EmailService from "@src/services/EmailService";
import logger from "jet-logger";
import AuditService from "@src/services/AuditService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import E2EAccountService, { E2EError, e2eDeadline } from "@src/services/E2EAccountService";
import { isAdminEmail } from "@src/services/DiscountService";

export function publicUser(user: {
  id: number;
  username: string;
  email: string;
  fullName?: string | null;
  e2eEnabled?: boolean;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    fullName: user.fullName,
    e2eEnabled: Boolean(user.e2eEnabled),
  };
}

export function sessionMeta(req: Request): SessionMeta {
  return { userAgent: req.get("user-agent"), ip: req.ip };
}

function notifyTwoFactorChanged(user: User, enabled: boolean) {
  EmailService.sendTwoFactorChanged({ to: user.email, enabled }).catch(
    (error) => logger.err(error, true)
  );
}

async function recordFailedLogin(req: Request, kind: "web" | "extension") {
  const email = String(req.body?.email || "").trim();
  const user = email ? await User.findOne({ where: { email }, attributes: ["id"] }) : null;
  if (!user) return;
  await AuditService.record({ actorId: user.id, action: "login_failed", details: { kind }, req });
}

async function currentUser(req: AuthRequest, res: Response) {
  const user = req.user?.id ? await User.findByPk(req.user.id) : null;
  if (!user) {
    res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
  }
  return user;
}

export default class AuthController {
  static login = async (req: Request, res: Response, next: NextFunction) => {
    // #swagger.tags = ["Auth"]
    /* #swagger.security = [{
            "apiKey": []
    }] */
    try {
      const { email, password, authKey } = req.body;

      const user = await AuthService.login({ email, password, authKey });
      if (user.twoFactorEnabled) {
        res.status(HttpStatusCodes.OK).send({
          twoFactorRequired: true,
          challengeToken: AuthService.createLoginChallenge(user, "web"),
        });
        return;
      }

      const session = await AuthService.issueSession(user, sessionMeta(req));
      setAuthCookies(res, session.accessToken, session.refreshToken);
      await AuditService.record({ actorId: user.id, action: "login", details: { kind: "web" }, req });

      res.status(HttpStatusCodes.OK).send({
        user: publicUser(user),
      });
    } catch (e: any) {
      if (e.message === E2E_REQUIRED) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          code: "e2e_required",
          message: "This account uses a master password. Reload the page to sign in.",
        });
      } else if (e.message === "Invalid credentials") {
        await recordFailedLogin(req, "web");
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  static register = async (req: Request, res: Response, next: NextFunction) => {
    // #swagger.tags = ["Auth"]
    try {
      const { username, email, fullName, e2e } = req.body;
      // Every new account is end-to-end (stage 10.6): the browser makes the
      // keys, and the password itself never arrives here.
      if (!e2e) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          code: "e2e_required",
          message: "Create your account in the 2keevo app: it sets up your encryption keys.",
        });
        return;
      }
      const keys = await E2EAccountService.checkedBundle(e2e);

      const user = await AuthService.register({
        username,
        email,
        password: keys.password,
        fullName,
        e2e: keys,
      });

      const session = await AuthService.issueSession(user, sessionMeta(req));
      setAuthCookies(res, session.accessToken, session.refreshToken);

      res.status(HttpStatusCodes.CREATED).send({
        message: "User registered successfully",
        user: publicUser(user),
      });
    } catch (e: any) {
      if (e instanceof E2EError) {
        res.status(e.status).send({ message: e.message });
        return;
      }
      if (e.message === "Username or email already exists") {
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          message: e.message,
        });
      } else {
        next(e);
      }
    }
  };

  static extensionLogin = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { email, password, authKey } = req.body;
      const user = await AuthService.login({ email, password, authKey });
      if (user.twoFactorEnabled) {
        res.status(HttpStatusCodes.OK).send({
          twoFactorRequired: true,
          challengeToken: AuthService.createLoginChallenge(user, "extension"),
        });
        return;
      }

      const session = await AuthService.issueExtensionSession(
        user,
        sessionMeta(req)
      );
      await AuditService.record({
        actorId: user.id,
        action: "login",
        details: { kind: "extension" },
        req,
      });

      res.status(HttpStatusCodes.OK).send({
        user: publicUser(user),
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    } catch (e: any) {
      if (e.message === E2E_REQUIRED) {
        // The popup can't derive keys yet (stage 10.5): sign in through the web app.
        res.status(HttpStatusCodes.BAD_REQUEST).send({
          code: "e2e_required",
          message: 'This account uses end-to-end encryption. Use "Sign in with the 2keevo web app".',
        });
      } else if (e.message === "Invalid credentials") {
        await recordFailedLogin(req, "extension");
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  static extensionConnect = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res
          .status(HttpStatusCodes.UNAUTHORIZED)
          .send({ message: "Sign in on the website first" });
        return;
      }

      const user = await User.findByPk(userId);
      if (!user) {
        res
          .status(HttpStatusCodes.UNAUTHORIZED)
          .send({ message: "Sign in on the website first" });
        return;
      }

      const session = await AuthService.issueExtensionSession(
        user,
        sessionMeta(req as unknown as Request)
      );
      res.status(HttpStatusCodes.OK).send({
        user: publicUser(user),
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    } catch (e) {
      next(e);
    }
  };

  static extensionRefresh = async (req: Request, res: Response) => {
    try {
      const session = await AuthService.rotateExtensionSession(
        req.body?.refreshToken,
        sessionMeta(req)
      );
      res.status(HttpStatusCodes.OK).send(session);
    } catch {
      res
        .status(HttpStatusCodes.UNAUTHORIZED)
        .send({ message: "Unauthorized" });
    }
  };

  static extensionLogout = async (req: Request, res: Response) => {
    await AuthService.revokeExtensionSession(req.body?.refreshToken);
    res.status(HttpStatusCodes.OK).send({ ok: true });
  };

  static forgotPassword = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const message = await AuthService.requestPasswordReset(req.body?.email);
      res.status(HttpStatusCodes.OK).send({ message });
    } catch (e) {
      next(e);
    }
  };

  static resetPassword = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const resetUserId = await AuthService.resetPassword(
        req.body?.token,
        req.body?.password
      );
      await AuditService.record({ actorId: resetUserId, action: "password_reset", req });
      res.status(HttpStatusCodes.OK).send({
        message: "Password updated. Sign in with the new password.",
      });
    } catch (e: any) {
      if (
        e.message === "This reset link is invalid or has expired." ||
        e.message === "Password must be at least 6 characters." ||
        e.message === MASTER_RESET_REFUSED
      ) {
        res.status(HttpStatusCodes.BAD_REQUEST).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  static refresh = async (req: Request, res: Response) => {
    try {
      const session = await AuthService.rotateSession(
        req.cookies?.refresh_token,
        sessionMeta(req)
      );
      setAuthCookies(res, session.accessToken, session.refreshToken);
      res.status(HttpStatusCodes.OK).send({ ok: true });
    } catch (error) {
      // Why it was refused, to find out why some sessions end early (unlock after idle time).
      const reason = error instanceof RefreshError ? error.reason : "error";
      logger.warn(`Refresh refused: ${reason} ${JSON.stringify(error instanceof RefreshError ? error.detail : { message: (error as Error)?.message })}`);
      clearAuthCookies(res);
      res
        .status(HttpStatusCodes.UNAUTHORIZED)
        .send({ message: "Unauthorized", reason });
    }
  };

  static logout = async (req: Request, res: Response) => {
    await AuthService.revokeSession(req.cookies?.refresh_token);
    clearAuthCookies(res);
    res.status(HttpStatusCodes.OK).send({ ok: true });
  };

  static verifyTwoFactor = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const user = await AuthService.readLoginChallenge(
        req.body?.challengeToken,
        "web"
      );
      if (!(await TwoFactorService.verify(user.id, req.body?.code))) {
        await AuditService.record({
          actorId: user.id,
          action: "two_factor_failed",
          details: { kind: "web" },
          req,
        });
        res
          .status(HttpStatusCodes.UNAUTHORIZED)
          .send({ message: "That code is not valid." });
        return;
      }

      const session = await AuthService.issueSession(user, sessionMeta(req));
      setAuthCookies(res, session.accessToken, session.refreshToken);
      await AuditService.record({
        actorId: user.id,
        action: "login",
        details: { kind: "web", twoFactor: true },
        req,
      });
      res.status(HttpStatusCodes.OK).send({ user: publicUser(user) });
    } catch (e: any) {
      if (e.message === "Sign-in expired. Enter your password again.") {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  static extensionVerifyTwoFactor = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const user = await AuthService.readLoginChallenge(
        req.body?.challengeToken,
        "extension"
      );
      if (!(await TwoFactorService.verify(user.id, req.body?.code))) {
        await AuditService.record({
          actorId: user.id,
          action: "two_factor_failed",
          details: { kind: "extension" },
          req,
        });
        res
          .status(HttpStatusCodes.UNAUTHORIZED)
          .send({ message: "That code is not valid." });
        return;
      }

      const session = await AuthService.issueExtensionSession(
        user,
        sessionMeta(req)
      );
      await AuditService.record({
        actorId: user.id,
        action: "login",
        details: { kind: "extension", twoFactor: true },
        req,
      });
      res.status(HttpStatusCodes.OK).send({
        user: publicUser(user),
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    } catch (e: any) {
      if (e.message === "Sign-in expired. Enter your password again.") {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  static twoFactorStatus = async (req: AuthRequest, res: Response) => {
    const user = await currentUser(req, res);
    if (!user) return;
    res.status(HttpStatusCodes.OK).send(TwoFactorService.status(user));
  };

  static twoFactorSetup = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const user = await currentUser(req, res);
      if (!user) return;
      res.status(HttpStatusCodes.OK).send(await TwoFactorService.setup(user));
    } catch (e) {
      AuthController.twoFactorFailure(e, res, next);
    }
  };

  static twoFactorEnable = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const user = await currentUser(req, res);
      if (!user) return;
      const recoveryCodes = await TwoFactorService.enable(user, req.body?.code);
      // Companies that require 2FA open up at once.
      CompanyPolicyService.clear(user.id);
      // Anyone already signed in elsewhere has not passed the new second factor.
      await SessionService.revokeAll(user.id, req.user?.sessionId);
      notifyTwoFactorChanged(user, true);
      await AuditService.record({ actorId: user.id, action: "two_factor_enabled", req: req as unknown as Request });
      res.status(HttpStatusCodes.OK).send({ recoveryCodes });
    } catch (e) {
      AuthController.twoFactorFailure(e, res, next);
    }
  };

  static twoFactorDisable = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const user = await currentUser(req, res);
      if (!user) return;
      await TwoFactorService.disable(user, req.body?.password, req.body?.code);
      CompanyPolicyService.clear(user.id);
      notifyTwoFactorChanged(user, false);
      await AuditService.record({ actorId: user.id, action: "two_factor_disabled", req: req as unknown as Request });
      res.status(HttpStatusCodes.OK).send({ ok: true });
    } catch (e) {
      AuthController.twoFactorFailure(e, res, next);
    }
  };

  static twoFactorRecoveryCodes = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const user = await currentUser(req, res);
      if (!user) return;
      const recoveryCodes = await TwoFactorService.regenerateRecoveryCodes(
        user,
        req.body?.code
      );
      await AuditService.record({
        actorId: user.id,
        action: "recovery_codes_regenerated",
        req: req as unknown as Request,
      });
      res.status(HttpStatusCodes.OK).send({ recoveryCodes });
    } catch (e) {
      AuthController.twoFactorFailure(e, res, next);
    }
  };

  static listSessions = async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
      return;
    }

    const sessions = await SessionService.list(userId);
    res.status(HttpStatusCodes.OK).send(
      sessions.map((session) => ({
        id: session.id,
        kind: session.kind,
        userAgent: session.userAgent,
        ip: session.ip,
        lastUsedAt: session.lastUsedAt,
        createdAt: session.createdAt,
        current: session.id === req.user?.sessionId,
      }))
    );
  };

  static revokeSession = async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const sessionId = parseInt(String(req.params.id), 10);
    if (!userId) {
      res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
      return;
    }

    const removed = isNaN(sessionId)
      ? 0
      : await SessionService.revoke(userId, sessionId);
    if (!removed) {
      res
        .status(HttpStatusCodes.NOT_FOUND)
        .send({ message: "Session not found" });
      return;
    }
    await AuditService.record({
      actorId: userId,
      action: "session_revoked",
      details: { sessionId },
      req: req as unknown as Request,
    });
    if (sessionId === req.user?.sessionId) {
      clearAuthCookies(res);
    }
    res.status(HttpStatusCodes.OK).send({ ok: true });
  };

  static revokeOtherSessions = async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
      return;
    }

    await SessionService.revokeAll(userId, req.user?.sessionId);
    await AuditService.record({
      actorId: userId,
      action: "other_sessions_revoked",
      req: req as unknown as Request,
    });
    res.status(HttpStatusCodes.OK).send({ ok: true });
  };

  static accountActivity = async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
      return;
    }
    const before = parseInt(String(req.query.before || ""));
    res
      .status(HttpStatusCodes.OK)
      .send(await AuditService.accountActivity(userId, isNaN(before) ? undefined : before));
  };

  private static twoFactorFailure(
    e: unknown,
    res: Response,
    next: NextFunction
  ) {
    if (e instanceof TwoFactorError) {
      res.status(HttpStatusCodes.BAD_REQUEST).send({ message: e.message });
    } else {
      next(e);
    }
  }

  static me = async (req: AuthRequest, res: Response, next: NextFunction) => {
    // #swagger.tags = ["Auth"]
    /* #swagger.security = [{
            "apiKey": []
    }] */
    try {
      const userId = req.user?.id;

      if (!userId) {
        res
          .status(HttpStatusCodes.UNAUTHORIZED)
          .send({ message: "Unauthorized" });
        return;
      }

      const user = await UserService.getUserById(userId);

      if (!user) {
        res
          .status(HttpStatusCodes.NOT_FOUND)
          .send({ message: "User not found" });
        return;
      }

      // The vault app shows its lock screen straight away for a locked session.
      // Auto-lock after company rules, and the cap itself so the settings can show it.
      const rules = await CompanyPolicyService.forUser(user.id);
      res.status(HttpStatusCodes.OK).send({
        ...user.toJSON(),
        autoLockMinutes: CompanyPolicyService.effectiveAutoLock(user.autoLockMinutes ?? 15, rules),
        autoLockLimit: rules.maxIdleMinutes,
        locked: Boolean((req.user as { locked?: boolean } | undefined)?.locked),
        // 2keevo's own admins see the admin view (ADMIN_EMAILS).
        ...(isAdminEmail(user.email) ? { isAdmin: true } : {}),
        // Accounts without end-to-end encryption must turn it on by then (E2E_DEADLINE).
        ...(!user.e2eEnabled && e2eDeadline() ? { e2eDeadline: e2eDeadline() } : {}),
      });
    } catch (e) {
      next(e);
    }
  };

  static searchUsers = async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const q = String(req.query.q || "");

    if (!userId) {
      res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: "Unauthorized" });
      return;
    }

    const companyRaw = req.query.company;
    const companyId = companyRaw ? parseInt(String(companyRaw), 10) : undefined;
    const users = await UserService.searchUsers(
      q,
      userId,
      companyId && !isNaN(companyId) ? companyId : undefined
    );
    res.status(HttpStatusCodes.OK).send(users);
  };
}
