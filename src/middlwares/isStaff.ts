import { NextFunction, RequestHandler, Response } from "express";
import { Op } from "sequelize";
import HttpStatusCodes from "@src/common/HttpStatusCodes";
import UserSession from "@src/models/UserSession";
import User from "@src/models/User";
import StaffService from "@src/services/admin/StaffService";
import { adminSessionUsable } from "@src/services/SessionService";
import { tokenVerify } from "@src/util/token";
import { ADMIN_ACCESS_COOKIE } from "@src/util/adminCookies";
import { StaffRequest } from "@src/types";

// Activity is written at most once a minute, not on every request.
const TOUCH_EVERY_MS = 60 * 1000;

function expired(res: Response) {
  res.status(HttpStatusCodes.UNAUTHORIZED).send({
    code: "session_expired",
    message: "Staff session expired",
  });
}

/** Staff only: an admin_access cookie for a live admin session of someone who is staff. */
const isStaff: RequestHandler = (req: StaffRequest, res: Response, next: NextFunction) => {
  // Database errors go to the error handler instead of hanging the request.
  check(req, res, next).catch(next);
};

async function check(req: StaffRequest, res: Response, next: NextFunction) {
  let userId: number;
  let session: UserSession | null;
  try {
    // Only the admin cookie: a vault token (header or cookie) never counts here.
    const payload = tokenVerify(req.cookies?.[ADMIN_ACCESS_COOKIE] as string | undefined);
    if (!payload.userId || payload.type !== "admin_access" || !payload.sid) {
      expired(res);
      return;
    }
    userId = payload.userId;
    session = await UserSession.findOne({
      where: { id: payload.sid, userId, kind: "admin", expiresAt: { [Op.gt]: new Date() } },
      attributes: ["id", "createdAt", "lastActiveAt"],
    });
  } catch {
    expired(res);
    return;
  }

  const now = Date.now();
  if (!session || !adminSessionUsable({ createdAt: session.createdAt, lastActiveAt: session.lastActiveAt ?? null }, now)) {
    expired(res);
    return;
  }

  const role = await StaffService.roleOf(userId);
  if (!role) {
    res.status(HttpStatusCodes.FORBIDDEN).send({ code: "not_staff", message: "Not a staff member" });
    return;
  }

  const lastActive = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
  if (now - lastActive >= TOUCH_EVERY_MS) {
    await UserSession.update({ lastActiveAt: new Date(now) }, { where: { id: session.id } });
  }

  const user = await User.findByPk(userId, { attributes: ["email"] });
  if (!user) {
    expired(res);
    return;
  }

  req.staff = { userId, email: user.email, role, sessionId: session.id };
  next();
}

export default isStaff;
