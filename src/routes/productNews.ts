import { NextFunction, Request, Response, Router } from "express";
import AnnouncementService, { checkNewsToken } from "@src/services/AnnouncementService";

// Product-news emails (announcements to existing users).
//   GET  /api/product-news/unsubscribe?u=&t=   the email's link (signed, no sign-in needed)
//   POST /api/product-news/unsubscribe?u=&t=   one-click unsubscribe from the mail app (RFC 8058)
const router = Router();

const PAGE = (text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2keevo</title></head>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#eeecf6;color:#18192f;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
<main style="max-width:440px;background:#fff;border-radius:16px;padding:28px;box-shadow:0 10px 30px rgba(24,25,47,.1)">
<p style="margin:0 0 8px;font-weight:700;font-size:20px">2keevo</p><p style="margin:0;line-height:1.5">${text}</p></main></body></html>`;

const unsubscribe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = Number(req.query.u);
    if (!checkNewsToken(userId, String(req.query.t || ""))) {
      res.status(400).type("html").send(PAGE("This link doesn't work. Write to support and we'll stop product news for you."));
      return;
    }
    await AnnouncementService.setProductNews(userId, false);
    res.type("html").send(PAGE("Done: you won't get product news from 2keevo anymore. Account and security emails still arrive."));
  } catch (e) {
    next(e);
  }
};

router.get("/unsubscribe", unsubscribe);
router.post("/unsubscribe", unsubscribe);

export default router;
