import { Response, NextFunction, RequestHandler } from "express";
import { tokenVerify } from "@src/util/token";
import HttpStatusCodes from "@src/common/HttpStatusCodes";
import CustomError from "@src/util/CustomError";
import AuthService from "@src/services/AuthService";
import UserService from "@src/services/UserService";

const isAuth: RequestHandler = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  if (req.method === "OPTIONS") {
    return next();
  }
  try {
    const token = req.headers["authorization"];

    if (!token) {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }
    const { userId, role }: any = tokenVerify(token);
    const user = await UserService.getUserById(userId);

    if (!user) {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }

    req.user = { id: userId, userId, role };
  } catch (err) {
    throw new CustomError(
      "User is not authorized",
      HttpStatusCodes.UNAUTHORIZED
    );
  }
  next();
  return;
};

export default isAuth;
