import { NextFunction, Request, Response, Router } from "express";
import isAuth from "@src/middlwares/isAuth";
import BreachDigestService, { checkUnsubscribeToken } from "@src/services/BreachDigestService";

// Breach alerts, phase 3: the opt-in weekly breach email.
//   GET  /api/breach-digest              (signed in) -> { enabled }
//   PUT  /api/breach-digest { enabled }  (signed in)
//   GET  /api/breach-digest/unsubscribe?u=&t=   the email's link (signed, no sign-in needed)
//   POST /api/breach-digest/unsubscribe?u=&t=   one-click unsubscribe from the mail app (RFC 8058)
const router = Router();
type AuthRequest = Request & { user?: { userId: number } };

router.get("/", isAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ enabled: await BreachDigestService.isOn(req.user!.userId) });
  } catch (e) {
    next(e);
  }
});

router.put("/", isAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ message: "Send { enabled: true | false }." });
      return;
    }
    await BreachDigestService.set(req.user!.userId, req.body.enabled);
    res.json({ enabled: req.body.enabled });
  } catch (e) {
    next(e);
  }
});

const PAGE = (text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2keevo</title></head>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#eeecf6;color:#18192f;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
<main style="max-width:440px;background:#fff;border-radius:16px;padding:28px;box-shadow:0 10px 30px rgba(24,25,47,.1)">
<p style="margin:0 0 8px;font-weight:700;font-size:20px">2keevo</p><p style="margin:0;line-height:1.5">${text}</p></main></body></html>`;

const unsubscribe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = Number(req.query.u);
    const token = String(req.query.t || "");
    if (!checkUnsubscribeToken(userId, token)) {
      res.status(400).type("html").send(PAGE("This link doesn't work. You can turn breach emails off in 2keevo under Settings › Security."));
      return;
    }
    await BreachDigestService.set(userId, false);
    res.type("html").send(PAGE("Done: you won't get breach emails anymore. Breach alerts still show in your vault, and you can turn the emails back on under Settings › Security."));
  } catch (e) {
    next(e);
  }
};

router.get("/unsubscribe", unsubscribe);
router.post("/unsubscribe", unsubscribe);

export default router;
