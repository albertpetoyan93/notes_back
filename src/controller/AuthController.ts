import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import AuthService from "../services/AuthService";
import { AuthRequest } from "@src/types";
import UserService from "@src/services/UserService";
import { clearAuthCookies, setAuthCookies } from "@src/util/authCookies";
import User from "@src/models/User";
import SessionService, { SessionMeta } from "@src/services/SessionService";
import TwoFactorService, { TwoFactorError } from "@src/services/TwoFactorService";
import EmailService from "@src/services/EmailService";
import logger from "jet-logger";

function publicUser(user: {
  id: number;
  username: string;
  email: string;
  fullName?: string | null;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    fullName: user.fullName,
  };
}

function sessionMeta(req: Request): SessionMeta {
  return { userAgent: req.get("user-agent"), ip: req.ip };
}

function notifyTwoFactorChanged(user: User, enabled: boolean) {
  EmailService.sendTwoFactorChanged({ to: user.email, enabled }).catch(
    (error) => logger.err(error, true)
  );
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
      const { email, password } = req.body;

      const user = await AuthService.login({ email, password });
      if (user.twoFactorEnabled) {
        res.status(HttpStatusCodes.OK).send({
          twoFactorRequired: true,
          challengeToken: AuthService.createLoginChallenge(user, "web"),
        });
        return;
      }

      const session = await AuthService.issueSession(user, sessionMeta(req));
      setAuthCookies(res, session.accessToken, session.refreshToken);

      res.status(HttpStatusCodes.OK).send({
        user: publicUser(user),
      });
    } catch (e: any) {
      if (e.message === "Invalid credentials") {
        res.status(HttpStatusCodes.UNAUTHORIZED).send({ message: e.message });
      } else {
        next(e);
      }
    }
  };

  static register = async (req: Request, res: Response, next: NextFunction) => {
    // #swagger.tags = ["Auth"]
    try {
      const { username, email, password, fullName } = req.body;

      const user = await AuthService.register({
        username,
        email,
        password,
        fullName,
      });

      const session = await AuthService.issueSession(user, sessionMeta(req));
      setAuthCookies(res, session.accessToken, session.refreshToken);

      res.status(HttpStatusCodes.CREATED).send({
        message: "User registered successfully",
        user: publicUser(user),
      });
    } catch (e: any) {
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
      const { email, password } = req.body;
      const user = await AuthService.login({ email, password });
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

      res.status(HttpStatusCodes.OK).send({
        user: publicUser(user),
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    } catch (e: any) {
      if (e.message === "Invalid credentials") {
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
      await AuthService.resetPassword(req.body?.token, req.body?.password);
      res.status(HttpStatusCodes.OK).send({
        message: "Password updated. Sign in with the new password.",
      });
    } catch (e: any) {
      if (
        e.message === "This reset link is invalid or has expired." ||
        e.message === "Password must be at least 6 characters."
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
    } catch {
      clearAuthCookies(res);
      res
        .status(HttpStatusCodes.UNAUTHORIZED)
        .send({ message: "Unauthorized" });
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
        res
          .status(HttpStatusCodes.UNAUTHORIZED)
          .send({ message: "That code is not valid." });
        return;
      }

      const session = await AuthService.issueSession(user, sessionMeta(req));
      setAuthCookies(res, session.accessToken, session.refreshToken);
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
        res
          .status(HttpStatusCodes.UNAUTHORIZED)
          .send({ message: "That code is not valid." });
        return;
      }

      const session = await AuthService.issueExtensionSession(
        user,
        sessionMeta(req)
      );
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
      // Anyone already signed in elsewhere has not passed the new second factor.
      await SessionService.revokeAll(user.id, req.user?.sessionId);
      notifyTwoFactorChanged(user, true);
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
      notifyTwoFactorChanged(user, false);
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
    res.status(HttpStatusCodes.OK).send({ ok: true });
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

      res.status(HttpStatusCodes.OK).send(user);
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
