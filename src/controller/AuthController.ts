import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import AuthService from "../services/AuthService";
import { AuthRequest } from "@src/types";
import UserService from "@src/services/UserService";

export default class AuthController {
  static login = async (req: Request, res: Response, next: NextFunction) => {
    // #swagger.tags = ["Auth"]
    /* #swagger.security = [{
            "apiKey": []
    }] */
    try {
      const { email, password } = req.body;

      const user = await AuthService.login({ email, password });

      const accessToken = AuthService.generateToken(user.id, user.email);
      const refreshToken = AuthService.generateToken(user.id, user.email);

      res.status(HttpStatusCodes.OK).send({
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.fullName,
        },
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

      const accessToken = AuthService.generateToken(user.id, user.username);
      const refreshToken = AuthService.generateToken(user.id, user.username);

      res.status(HttpStatusCodes.CREATED).send({
        message: "User registered successfully",
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.fullName,
        },
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
}
