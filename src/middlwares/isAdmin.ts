import { NextFunction, RequestHandler, Response } from "express";
import HttpStatusCodes from "@src/common/HttpStatusCodes";
import User from "@src/models/User";
import { isAdminEmail } from "@src/services/DiscountService";

/** 2keevo's own admins (ADMIN_EMAILS). Runs after isAuth. */
const isAdmin: RequestHandler = async (req: any, res: Response, next: NextFunction) => {
  const user = req.user?.id ? await User.findByPk(req.user.id, { attributes: ["email"] }) : null;
  if (!isAdminEmail(user?.email)) {
    res.status(HttpStatusCodes.FORBIDDEN).send({ message: "Not allowed" });
    return;
  }
  next();
};

export default isAdmin;
