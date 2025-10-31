import { Request, Response, NextFunction, RequestHandler } from "express";
import HttpStatusCodes from "@src/common/HttpStatusCodes";

const checkRole = (roles: string[]): RequestHandler => {
  return (req: any, res, next) => {
    const user = req.user;
    if (!user || !roles.includes(user.role)) {
      res
        .status(HttpStatusCodes.FORBIDDEN)
        .send("Forbidden: insufficient role");
      return;
    }
    next();
  };
};

export default checkRole;
