import { NextFunction, Request, Response } from "express";
import AuditService from "../services/AuditService";
import SecretLinkService, { SecretLinkError } from "../services/SecretLinkService";

type AuthedRequest = Request & { user?: { id: number } };

const fail = (error: unknown, res: Response, next: NextFunction) => {
  if (error instanceof SecretLinkError) {
    res.status(error.status).send({ message: error.message });
    return;
  }
  next(error);
};

export default class SecretLinkController {
  static create = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const link = await SecretLinkService.create(userId, req.body);
      await AuditService.record({
        actorId: userId,
        action: "secret_link_created",
        noteId: req.body?.noteId ? Number(req.body.noteId) : null,
        details: {
          linkId: link.id,
          maxViews: link.maxViews,
          expiresAt: link.expiresAt,
          passphrase: Boolean(req.body?.salt),
          ...(link.label ? { label: link.label } : {}),
        },
        req,
      });
      res.status(201).send(link);
    } catch (error) {
      fail(error, res, next);
    }
  };

  static list = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.send(await SecretLinkService.listMine(req.user!.id));
    } catch (error) {
      fail(error, res, next);
    }
  };

  static revoke = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const done = await SecretLinkService.revoke(req.user!.id, String(req.params.id));
      if (!done) {
        res.status(404).send({ message: "Link not found" });
        return;
      }
      await AuditService.record({
        actorId: req.user!.id,
        action: "secret_link_revoked",
        details: { linkId: String(req.params.id) },
        req,
      });
      res.send({ revoked: true });
    } catch (error) {
      fail(error, res, next);
    }
  };

  /** Public. Never uses a view, so link previews in chat apps are harmless. */
  static peek = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.set("Cache-Control", "no-store");
      res.send(await SecretLinkService.peek(String(req.params.id)));
    } catch (error) {
      fail(error, res, next);
    }
  };

  /** Public. Uses one view and returns the ciphertext. */
  static open = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.set("Cache-Control", "no-store");
      const opened = await SecretLinkService.open(String(req.params.id));
      // In the creator's account activity, with the opener's IP and browser.
      await AuditService.record({
        actorId: opened.creator,
        action: "secret_link_opened",
        noteId: opened.noteId,
        details: {
          linkId: String(req.params.id),
          viewsLeft: opened.viewsLeft,
          ...(opened.label ? { label: opened.label } : {}),
        },
        req,
      });
      res.send({ ciphertext: opened.ciphertext, iv: opened.iv, viewsLeft: opened.viewsLeft });
    } catch (error) {
      fail(error, res, next);
    }
  };
}
