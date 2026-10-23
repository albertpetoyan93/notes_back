import { Response, NextFunction, RequestHandler } from "express";
import { tokenVerify } from "@src/util/token";
import HttpStatusCodes from "@src/common/HttpStatusCodes";
import CustomError from "@src/util/CustomError";
import UserService from "@src/services/UserService";
import SessionService from "@src/services/SessionService";

const isAuth: RequestHandler = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  if (req.method === "OPTIONS") {
    return next();
  }
  try {
    const header = req.headers.authorization;
    const bearer =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : undefined;
    // An explicit Authorization header wins. Chrome also attaches the vault's cookies
    // to the extension's requests, and the extension must act as its own session.
    const token = bearer || (req.cookies?.access_token as string | undefined);

    if (!token) {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }
    const { userId, type, sid } = tokenVerify(token);
    // Only access tokens: refresh and 2FA-challenge tokens are signed with the same secret.
    if (!userId || type !== "access") {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }
    const user = await UserService.getUserById(userId);

    if (!user) {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }

    // Tokens from before per-device sessions have no sid; they expire within 15 minutes.
    if (sid && !(await SessionService.isActive(sid, userId))) {
      throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
    }

    req.user = { id: userId, userId, sessionId: sid };
  } catch {
    throw new CustomError(
      "User is not authorized",
      HttpStatusCodes.UNAUTHORIZED
    );
  }
  next();
  return;
};

export default isAuth;
