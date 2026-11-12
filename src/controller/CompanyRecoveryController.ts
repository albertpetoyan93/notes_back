import { Response } from "express";
import AuditService from "../services/AuditService";
import CompanyRecoveryService, { RecoveryError } from "../services/CompanyRecoveryService";
import { E2EError } from "../services/E2EAccountService";
import VaultRecoveryService from "../services/VaultRecoveryService";

const auditRequest = (
  req: any,
  action:
    | "vault_recovery_requested"
    | "vault_recovery_approved"
    | "vault_recovery_cancelled"
    | "vault_recovery_completed"
    | "vault_recovery_copy_dropped",
  companyId: number,
  request: { id: number; collectionId: number; granteeUserId: number }
) =>
  AuditService.record({
    actorId: req.user?.id,
    action,
    companyId,
    targetUserId: request.granteeUserId,
    details: { requestId: request.id, collectionId: request.collectionId, granteeUserId: request.granteeUserId },
    req,
  });

const fail = (error: any, res: Response, what: string) => {
  if (error instanceof RecoveryError || error instanceof E2EError) {
    return res.status(error.status).json({ message: error.message });
  }
  console.error(`Error with vault recovery (${what}):`, error);
  return res.status(500).json({ message: "Something went wrong. Try again." });
};

export const handle =
  (what: string, run: (req: any, res: Response) => Promise<unknown>) => async (req: any, res: Response) => {
    try {
      const result = await run(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      fail(error, res, what);
    }
  };

// Vault recovery: the recovery key, its custodians and recovery copies (see CompanyRecoveryService).
export default class CompanyRecoveryController {
  static status = handle("status", (req) => CompanyRecoveryService.status(Number(req.params.id), req.user?.id));

  static enable = handle("enable", async (req) => {
    const companyId = Number(req.params.id);
    const result = await CompanyRecoveryService.enable(companyId, req.user?.id, req.body);
    await AuditService.record({ actorId: req.user?.id, action: "company_recovery_enabled", companyId, details: result, req });
  });

  static disable = handle("disable", async (req) => {
    const companyId = Number(req.params.id);
    await CompanyRecoveryService.disable(companyId, req.user?.id);
    await AuditService.record({ actorId: req.user?.id, action: "company_recovery_disabled", companyId, req });
  });

  static settings = handle("settings", async (req) => {
    const companyId = Number(req.params.id);
    const result = await CompanyRecoveryService.updateSettings(companyId, req.user?.id, req.body);
    if (result.waitHours !== undefined) {
      await AuditService.record({
        actorId: req.user?.id,
        action: "recovery_settings_changed",
        companyId,
        details: { waitHours: result.waitHours },
        req,
      });
    }
    if (result.added?.length || result.removed?.length) {
      await AuditService.record({
        actorId: req.user?.id,
        action: "recovery_custodians_changed",
        companyId,
        details: { added: result.added, removed: result.removed },
        req,
      });
    }
    return result;
  });

  // Recovery requests (VaultRecoveryService): every state change is audited.
  static requests = handle("requests", (req) => VaultRecoveryService.list(Number(req.params.id), req.user?.id));

  static createRequest = handle("request", async (req) => {
    const companyId = Number(req.params.id);
    const request = await VaultRecoveryService.create(companyId, req.user?.id, req.body);
    await auditRequest(req, "vault_recovery_requested", companyId, request);
    return { id: request.id, status: request.status, availableAt: request.availableAt };
  });

  static approveRequest = handle("approve", async (req) => {
    const companyId = Number(req.params.id);
    const request = await VaultRecoveryService.approve(companyId, req.user?.id, Number(req.params.requestId));
    await auditRequest(req, "vault_recovery_approved", companyId, request);
    return { id: request.id, status: request.status, availableAt: request.availableAt };
  });

  static cancelRequest = handle("cancel", async (req) => {
    const companyId = Number(req.params.id);
    const request = await VaultRecoveryService.cancel(companyId, req.user?.id, Number(req.params.requestId));
    await auditRequest(req, "vault_recovery_cancelled", companyId, request);
    return { id: request.id, status: request.status };
  });

  static material = handle("material", (req) =>
    VaultRecoveryService.material(Number(req.params.id), req.user?.id, Number(req.params.requestId))
  );

  static dropCopy = handle("drop copy", async (req) => {
    const companyId = Number(req.params.id);
    const request = await VaultRecoveryService.dropCopy(
      companyId,
      req.user?.id,
      Number(req.params.requestId),
      Number(req.query.copyId ?? req.body?.copyId)
    );
    await auditRequest(req, "vault_recovery_copy_dropped", companyId, request);
    return { ok: true };
  });

  static completeRequest = handle("complete", async (req) => {
    const companyId = Number(req.params.id);
    const request = await VaultRecoveryService.complete(companyId, req.user?.id, Number(req.params.requestId), req.body);
    await auditRequest(req, "vault_recovery_completed", companyId, request);
    return { id: request.id, status: request.status };
  });

  static tasks = handle("tasks", (req) => CompanyRecoveryService.tasks(req.user?.id));
  static grant = handle("grant", (req) => CompanyRecoveryService.grant(req.user?.id, req.body));
  static rotate = handle("rotate", (req) => CompanyRecoveryService.rotate(req.user?.id, req.body));
  static continuity = handle("continuity", (req) => CompanyRecoveryService.saveContinuity(req.user?.id, req.body));
}
