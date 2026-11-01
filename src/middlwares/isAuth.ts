import { Response, NextFunction, RequestHandler } from "express";
import { tokenVerify } from "@src/util/token";
import HttpStatusCodes from "@src/common/HttpStatusCodes";
import CustomError from "@src/util/CustomError";
import UserService from "@src/services/UserService";
import SessionService from "@src/services/SessionService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import ActivityService from "@src/services/ActivityService";
import { parseExtensionVersion } from "@src/services/admin/extensionVersion";

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
  let kind: string | null = null;
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
      // Staff sessions never open the vault.
      if (!state.active || state.kind === "admin") {
        throw new CustomError("Unauthorized", HttpStatusCodes.UNAUTHORIZED);
      }
      locked = state.locked;
      kind = state.kind;
    }

    req.user = { id: userId, userId, sessionId: sid, locked };
  } catch {
    // The code tells the app to refresh the access token and retry, even on
    // routes where a plain 401 means a wrong password (unlock after idle time:
    // the 15-minute access token has expired by then).
    res.status(HttpStatusCodes.UNAUTHORIZED).send({
      code: "session_expired",
      message: "User is not authorized",
    });
    return;
  }

  const path = String(req.originalUrl || "").split("?")[0].replace(/\/+$/, "");
  if (locked && !OPEN_WHILE_LOCKED.has(path)) {
    res.status(HttpStatusCodes.LOCKED).send({
      code: "locked",
      message: "2keevo is locked. Unlock it to continue.",
    });
    return;
  }
  // Counts the person as active today (fire-and-forget; a locked vault is not use).
  if (!locked && (kind === "web" || kind === "extension")) {
    ActivityService.note(req.user.userId, kind);
  }
  if (kind === "extension" && req.user.sessionId) {
    const version = parseExtensionVersion(req.get("x-keevo-extension-version"));
    if (version) SessionService.noteExtensionVersion(req.user.sessionId, req.user.userId, version);
  }
  next();
  return;
};

export default isAuth;
