import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import AuthService from "../services/AuthService";
import { AuthRequest } from "@src/types";
import UserService from "@src/services/UserService";
import { clearAuthCookies, setAuthCookies } from "@src/util/authCookies";

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

export default class AuthController {
  static login = async (req: Request, res: Response, next: NextFunction) => {
    // #swagger.tags = ["Auth"]
    /* #swagger.security = [{
            "apiKey": []
    }] */
    try {
      const { email, password } = req.body;

      const user = await AuthService.login({ email, password });
      const session = await AuthService.issueSession(user);
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

      const session = await AuthService.issueSession(user);
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

  static refresh = async (req: Request, res: Response) => {
    try {
      const session = await AuthService.rotateSession(
        req.cookies?.refresh_token
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

    const users = await UserService.searchUsers(q, userId);
    res.status(HttpStatusCodes.OK).send(users);
  };
}
