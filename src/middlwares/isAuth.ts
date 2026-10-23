import { Response, NextFunction, RequestHandler } from "express";
import { tokenVerify } from "@src/util/token";
import HttpStatusCodes from "@src/common/HttpStatusCodes";
import CustomError from "@src/util/CustomError";
import UserService from "@src/services/UserService";
import SessionService from "@src/services/SessionService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";

// What a locked session may still do: see who it is, unlock, lock, sign out.
// Everything else answers 423, so a new route is locked by default.
const OPEN_WHILE_LOCKED = new Set([
  "/api/auth/me",
  "/api/auth/lock",
  "/api/auth/unlock",
  "/api/auth/unlock/passkey/options",
  "/api/auth/unlock/passkey",
  "/api/auth/logout",
]);

const isAuth: RequestHandler = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  if (req.method === "OPTIONS") {
    return next();
  }
  let locked = false;
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
    if (sid) {
      // A company can cap how long its members' vault may sit idle.
      const rules = await CompanyPolicyService.forUser(userId);
      const minutes = CompanyPolicyService.effectiveAutoLock(user.autoLockMinutes ?? 15, rules);
      const state = await SessionService.state(sid, userId, minutes);
      if (!state.active) {
        throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
      }
      locked = state.locked;
    }

    req.user = { id: userId, userId, sessionId: sid, locked };
  } catch {
    throw new CustomError(
      "User is not authorized",
      HttpStatusCodes.UNAUTHORIZED
    );
  }

  const path = String(req.originalUrl || "").split("?")[0].replace(/\/+$/, "");
  if (locked && !OPEN_WHILE_LOCKED.has(path)) {
    res.status(HttpStatusCodes.LOCKED).send({
      code: "locked",
      message: "2keevo is locked. Unlock it to continue.",
    });
    return;
  }
  next();
  return;
};

export default isAuth;
