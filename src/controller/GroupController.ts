import { Response } from "express";
import AuditService from "../services/AuditService";
import GroupService, { GroupError } from "../services/GroupService";

async function respond(res: Response, fallback: string, run: () => Promise<unknown>) {
  try {
    res.json((await run()) ?? { ok: true });
  } catch (error: any) {
    if (error instanceof GroupError) return res.status(error.status).json({ message: error.message });
    console.error(fallback, error);
    res.status(500).json({ message: fallback });
  }
}

const num = (value: unknown) => Number.parseInt(String(value), 10);

/** Groups in companies, and asking to join one (plans/vault-features.md, phase B). */
export default class GroupController {
  static list = async (req: any, res: Response) =>
    respond(res, "Could not load groups", () => GroupService.list(num(req.params.id), req.user.id));

  /** Body: { name }. */
  static create = async (req: any, res: Response) =>
    respond(res, "Could not create the group", async () => {
      const companyId = num(req.params.id);
      const group = await GroupService.create(companyId, req.user.id, req.body?.name);
      await AuditService.record({ actorId: req.user.id, action: "group_created", companyId, details: { group: group.name }, req });
      return group;
    });

  static rename = async (req: any, res: Response) =>
    respond(res, "Could not rename the group", async () => {
      const companyId = num(req.params.id);
      const group = await GroupService.rename(companyId, req.user.id, num(req.params.groupId), req.body?.name);
      await AuditService.record({ actorId: req.user.id, action: "group_renamed", companyId, details: { group: group.name }, req });
      return group;
    });

  static remove = async (req: any, res: Response) =>
    respond(res, "Could not delete the group", async () => {
      const companyId = num(req.params.id);
      const { name } = await GroupService.remove(companyId, req.user.id, num(req.params.groupId));
      await AuditService.record({ actorId: req.user.id, action: "group_deleted", companyId, details: { group: name }, req });
    });

  /** Body: { userIds }. */
  static addMembers = async (req: any, res: Response) =>
    respond(res, "Could not add to the group", async () => {
      const companyId = num(req.params.id);
      const result = await GroupService.addMembers(companyId, req.user.id, num(req.params.groupId), req.body?.userIds);
      for (const targetUserId of result.added) {
        await AuditService.record({
          actorId: req.user.id,
          action: "group_member_added",
          companyId,
          targetUserId,
          details: { group: result.group },
          req,
        });
      }
      return result;
    });

  static removeMember = async (req: any, res: Response) =>
    respond(res, "Could not remove from the group", async () => {
      const companyId = num(req.params.id);
      const targetUserId = num(req.params.userId);
      const { group } = await GroupService.removeMember(companyId, req.user.id, num(req.params.groupId), targetUserId);
      await AuditService.record({ actorId: req.user.id, action: "group_member_removed", companyId, targetUserId, details: { group }, req });
    });

  /** Body: { groupId, permission }. */
  static shareCollection = async (req: any, res: Response) =>
    respond(res, "Could not share with the group", async () => {
      const companyId = num(req.params.id);
      const collectionId = num(req.params.collectionId);
      const result = await GroupService.shareCollection(companyId, req.user.id, collectionId, num(req.body?.groupId), req.body?.permission);
      await AuditService.record({
        actorId: req.user.id,
        action: "collection_group_shared",
        companyId,
        collectionId,
        details: { group: result.group, permission: result.permission },
        req,
      });
      return result;
    });

  static unshareCollection = async (req: any, res: Response) =>
    respond(res, "Could not update the share", async () => {
      const companyId = num(req.params.id);
      const collectionId = num(req.params.collectionId);
      const { group } = await GroupService.unshareCollection(companyId, req.user.id, collectionId, num(req.params.groupId));
      await AuditService.record({ actorId: req.user.id, action: "collection_group_unshared", companyId, collectionId, details: { group }, req });
    });

  /** Body: { note }. A member asks to join. */
  static request = async (req: any, res: Response) =>
    respond(res, "Could not send the request", async () => {
      const companyId = num(req.params.id);
      const { group } = await GroupService.request(companyId, req.user.id, num(req.params.groupId), req.body?.note);
      await AuditService.record({ actorId: req.user.id, action: "group_join_requested", companyId, details: { group }, req });
    });

  static cancelRequest = async (req: any, res: Response) =>
    respond(res, "Could not cancel the request", () => GroupService.cancelRequest(num(req.params.id), req.user.id, num(req.params.groupId)));

  static decide = (approve: boolean) => async (req: any, res: Response) =>
    respond(res, "Could not answer the request", async () => {
      const companyId = num(req.params.id);
      const result = await GroupService.decide(companyId, req.user.id, num(req.params.requestId), approve);
      await AuditService.record({
        actorId: req.user.id,
        action: approve ? "group_request_approved" : "group_request_declined",
        companyId,
        targetUserId: result.userId,
        details: { group: result.group },
        req,
      });
      return result;
    });
}
