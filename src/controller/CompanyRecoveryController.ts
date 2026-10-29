import { Response } from "express";
import AuditService from "../services/AuditService";
import CompanyRecoveryService, { RecoveryError } from "../services/CompanyRecoveryService";
import { E2EError } from "../services/E2EAccountService";
import EmailService from "../services/EmailService";
import NotificationService from "../services/NotificationService";

const fail = (error: any, res: Response, what: string) => {
  if (error instanceof RecoveryError || error instanceof E2EError) {
    return res.status(error.status).json({ message: error.message });
  }
  console.error(`Error with admin recovery (${what}):`, error);
  return res.status(500).json({ message: "Something went wrong. Try again." });
};

const handle =
  (what: string, run: (req: any, res: Response) => Promise<unknown>) => async (req: any, res: Response) => {
    try {
      const result = await run(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      fail(error, res, what);
    }
  };

// Company admin recovery (see CompanyRecoveryService).
export default class CompanyRecoveryController {
  static status = handle("status", (req) => CompanyRecoveryService.status(Number(req.params.id), req.user?.id));

  static enable = handle("enable", async (req) => {
    const companyId = Number(req.params.id);
    await CompanyRecoveryService.enable(companyId, req.user?.id, req.body);
    await AuditService.record({ actorId: req.user?.id, action: "company_recovery_enabled", companyId, req });
  });

  static disable = handle("disable", async (req) => {
    const companyId = Number(req.params.id);
    await CompanyRecoveryService.disable(companyId, req.user?.id);
    await AuditService.record({ actorId: req.user?.id, action: "company_recovery_disabled", companyId, req });
  });

  static tasks = handle("tasks", (req) => CompanyRecoveryService.tasks(req.user?.id));
  static enroll = handle("enroll", (req) => CompanyRecoveryService.enroll(req.user?.id, req.body));
  static grant = handle("grant", (req) => CompanyRecoveryService.grant(req.user?.id, req.body));
  static rotate = handle("rotate", (req) => CompanyRecoveryService.rotate(req.user?.id, req.body));

  static memberKeys = handle("member keys", (req) =>
    CompanyRecoveryService.memberKeys(Number(req.params.id), req.user?.id, Number(req.params.userId))
  );

  /** A temporary master password for a member; they're told, and choose their own at next sign-in. */
  static reset = handle("reset", async (req) => {
    const companyId = Number(req.params.id);
    const memberUserId = Number(req.params.userId);
    const member = await CompanyRecoveryService.reset(companyId, req.user?.id, memberUserId, req.body);
    await AuditService.record({
      actorId: req.user?.id,
      action: "master_password_reset_by_admin",
      companyId,
      targetUserId: memberUserId,
      req,
    });
    await NotificationService.create(
      memberUserId,
      "A company admin reset your master password. Sign in with the temporary one they give you, then choose your own."
    ).catch(() => undefined);
    EmailService.sendSecurityNotice({
      to: member.email,
      what: "A company admin reset your 2keevo master password. Sign in with the temporary password they give you; you'll then choose your own.",
    }).catch(() => undefined);
  });
}
