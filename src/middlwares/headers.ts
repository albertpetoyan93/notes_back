import { NextFunction, Response, Request } from "express";

const ALLOW_ORIGINS = ["*"];

export default function headers(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { origin } = req.headers;
    if ((origin && ALLOW_ORIGINS.includes(origin)) || 1) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, PATCH, OPTIONS"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization"
      );
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }

    next();
  } catch (e) {
    next(e);
  }
}
