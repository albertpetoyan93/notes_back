import { NextFunction, Response, Request } from "express";

function allowedOrigin(origin: string | undefined) {
  if (!origin) return null;

  const configured = (process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (configured.includes(origin)) return origin;

  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return origin;

  if (
    process.env.NODE_ENV !== "production" &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return origin;
  }

  return null;
}

export default function headers(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const origin = allowedOrigin(req.headers.origin);

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    );
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(origin ? 204 : 403);
    return;
  }

  next();
}
