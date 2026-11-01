import { NextFunction, RequestHandler, Response } from "express";
import HttpStatusCodes from "@src/common/HttpStatusCodes";
import { can, Permission } from "@src/admin/permissions";
import { StaffRequest } from "@src/types";

/** Runs after isStaff: the staff member's role must hold this permission. */
export default function requireStaff(permission: Permission): RequestHandler {
  return (req: StaffRequest, res: Response, next: NextFunction) => {
    if (!req.staff || !can(req.staff.role, permission)) {
      res.status(HttpStatusCodes.FORBIDDEN).send({ code: "forbidden", message: "Not allowed" });
      return;
    }
    next();
  };
}
