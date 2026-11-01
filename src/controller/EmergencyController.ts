import { Response } from "express";
import AuditService from "../services/AuditService";
import EmergencyAccessService, { EmergencyError } from "../services/EmergencyAccessService";
import { PlanLimitError, planLimitBody } from "../services/EntitlementService";

async function respond(res: Response, fallback: string, run: () => Promise<unknown>) {
  try {
    res.json((await run()) ?? { ok: true });
  } catch (error: any) {
    if (error instanceof EmergencyError) return res.status(error.status).json({ message: error.message });
    if (error instanceof PlanLimitError) return res.status(error.status).json(planLimitBody(error));
    console.error(fallback, error);
    res.status(500).json({ message: fallback });
  }
}

const id = (req: any) => Number(req.params.id);

/** Emergency access: trusted contacts (plans/vault-features.md, phase A). */
export default class EmergencyController {
  static summary = async (req: any, res: Response) =>
    respond(res, "Could not load emergency access", () => EmergencyAccessService.summary(req.user.id));

  /* The owner --------------------------------------------------------------------- */

  /** Body: { email, waitDays }. */
  static invite = async (req: any, res: Response) =>
    respond(res, "Could not add the contact", async () => {
      const result = await EmergencyAccessService.invite(req.user.id, req.body || {});
      await AuditService.record({ actorId: req.user.id, action: "emergency_invited", details: { waitDays: req.body?.waitDays }, req });
      return result;
    });

  /** Body: { waitDays }. */
  static setWait = async (req: any, res: Response) =>
    respond(res, "Could not change the waiting time", () => EmergencyAccessService.setWait(req.user.id, id(req), req.body?.waitDays));

  /** Body: { sealedUserKey }: the user key, sealed in the owner's browser to the contact. */
  static confirm = async (req: any, res: Response) =>
    respond(res, "Could not confirm the contact", async () => {
      await EmergencyAccessService.confirm(req.user.id, id(req), req.body?.sealedUserKey);
      await AuditService.record({ actorId: req.user.id, action: "emergency_confirmed", details: { contactRow: id(req) }, req });
    });

  static approve = async (req: any, res: Response) =>
    respond(res, "Could not approve the request", async () => {
      await EmergencyAccessService.approve(req.user.id, id(req));
      await AuditService.record({ actorId: req.user.id, action: "emergency_approved", details: { contactRow: id(req) }, req });
    });

  static refuse = async (req: any, res: Response) =>
    respond(res, "Could not refuse the request", async () => {
      const result = await EmergencyAccessService.refuse(req.user.id, id(req));
      await AuditService.record({
        actorId: req.user.id,
        action: "emergency_refused",
        details: { contactRow: id(req), ended: result.wasGranted },
        req,
      });
    });

  static remove = async (req: any, res: Response) =>
    respond(res, "Could not remove the contact", async () => {
      const { contactId } = await EmergencyAccessService.remove(req.user.id, id(req));
      await AuditService.record({ actorId: req.user.id, action: "emergency_removed", targetUserId: contactId, details: {}, req });
    });

  /* The contact ------------------------------------------------------------------- */

  static accept = async (req: any, res: Response) =>
    respond(res, "Could not accept", async () => {
      await EmergencyAccessService.accept(req.user.id, id(req));
      await AuditService.record({ actorId: req.user.id, action: "emergency_accepted", details: { contactRow: id(req) }, req });
    });

  static leave = async (req: any, res: Response) =>
    respond(res, "Could not leave", async () => {
      const { grantorId } = await EmergencyAccessService.leave(req.user.id, id(req));
      await AuditService.record({ actorId: req.user.id, action: "emergency_left", targetUserId: grantorId, details: {}, req });
    });

  static request = async (req: any, res: Response) =>
    respond(res, "Could not send the request", async () => {
      const result = await EmergencyAccessService.request(req.user.id, id(req));
      await AuditService.record({ actorId: req.user.id, action: "emergency_requested", details: { contactRow: id(req) }, req });
      return result;
    });

  static vault = async (req: any, res: Response) =>
    respond(res, "Could not open the vault", async () => {
      const result = await EmergencyAccessService.vault(req.user.id, id(req));
      await AuditService.record({
        actorId: req.user.id,
        action: "emergency_viewed",
        targetUserId: result.owner.id,
        details: { items: result.items.length },
        req,
      });
      return result;
    });
}
