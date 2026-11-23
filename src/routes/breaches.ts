import { Request, Response, Router } from "express";
import isAuth from "@src/middlwares/isAuth";
import BreachFeedService from "@src/services/BreachFeedService";

// GET /api/breaches?since=<ISO date>: the public list of breached websites (no user data).
// The vault matches it against its own logins in the browser (docs/features/breach-alerts.md).
const router = Router();

router.get("/", isAuth, async (req: Request, res: Response) => {
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  res.set("Cache-Control", "private, max-age=3600");
  res.json({ breaches: await BreachFeedService.list(since), source: "Have I Been Pwned" });
});

export default router;
