import { Response, NextFunction, RequestHandler } from "express";
import { tokenVerify } from "@src/util/token";
import HttpStatusCodes from "@src/common/HttpStatusCodes";
import CustomError from "@src/util/CustomError";
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
    const token = req.cookies?.access_token as string | undefined;

    if (!token) {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }
    const { userId, type } = tokenVerify(token);
    if (!userId || type === "refresh") {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }
    const user = await UserService.getUserById(userId);

    if (!user) {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }

    req.user = { id: userId, userId };
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
