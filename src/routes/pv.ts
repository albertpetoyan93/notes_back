import express, { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import TrafficService from "@src/services/TrafficService";

// Page views from 2keevo.com (POST /api/pv). Public, cookieless, always answers 204 so
// the website never waits on it or shows errors. Visitors who send Do Not Track or
// Global Privacy Control are not counted.
const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(204).end();
  },
});

// sendBeacon posts text/plain; parse it as JSON here (the app-wide parser only reads application/json).
router.post("/", limiter, express.text({ type: "text/plain", limit: "4kb" }), async (req: Request, res: Response) => {
  res.status(204).end();
  if (req.get("dnt") === "1" || req.get("sec-gpc") === "1") return;
  let body: unknown = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return;
    }
  }
  await TrafficService.record(body, req.ip || "", req.get("user-agent") || "");
});

export default router;
