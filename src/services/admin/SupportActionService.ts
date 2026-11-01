import type { Request } from "express";
import logger from "jet-logger";
import { Op } from "sequelize";
import sequelize from "../../configs/DB/sequelize";
import Company from "../../models/Company";
import CompanyMember from "../../models/CompanyMember";
import User from "../../models/User";
import type { StaffRequest } from "../../types";
import AuditService from "../AuditService";
import AuthService from "../AuthService";
import EmailService from "../EmailService";
import SessionService from "../SessionService";
import AdminActionService, { assertConfirmEmail, cleanReason } from "./AdminActionService";
import StaffService from "./StaffService";

export type Staff = NonNullable<StaffRequest["staff"]>;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export const actor = (staff: Staff) => ({ userId: staff.userId, email: staff.email, role: staff.role });

async function loadUser(userId: number) {
  const user = await User.findByPk(userId, { attributes: ["id", "email", "suspendedAt", "e2eEnabled"] });
  if (!user) throw fail(404, "User not found.");
  return user;
}

/** The user's own activity log and a short email. The action stands even if the email fails. */
export async function tellUser(user: { id: number; email: string }, what: string, companyId?: number) {
  await AuditService.record({
    actorId: user.id,
    action: "support_action",
    ...(companyId ? { companyId } : {}),
    details: { what },
  });
  try {
    await EmailService.sendSecurityNotice({ to: user.email, what });
  } catch (error) {
    logger.err(error, true);
  }
}

/**
 * What support can do to an account. Every action checks everything first, so
 * a refused action changes nothing and leaves no AdminAction row.
 */
class SupportActionService {
  /** The normal reset email; end-to-end accounts get the master-password help instead. */
  static async sendPasswordReset(staff: Staff, userId: number, reason: unknown, req: Request) {
    const why = cleanReason(reason);
    const user = await loadUser(userId);
    await AuthService.requestPasswordReset(user.email);
    await AdminActionService.record({
      staff: actor(staff),
      action: "password_reset_sent",
      targetUserId: user.id,
      reason: why,
      details: { e2e: Boolean(user.e2eEnabled) },
      req,
    });
  }

  /** Ends the user's vault and extension sessions; an admin-app session is left alone. */
  static async signOutAll(staff: Staff, userId: number, reason: unknown, req: Request) {
    const why = cleanReason(reason);
    const user = await loadUser(userId);
    await SessionService.revokeKinds(user.id, ["web", "extension"]);
    await AdminActionService.record({ staff: actor(staff), action: "sessions_revoked", targetUserId: user.id, reason: why, req });
    await tellUser(user, "2keevo support signed you out on all devices.");
  }

  static async suspend(staff: Staff, userId: number, reason: unknown, confirmEmail: unknown, req: Request) {
    const why = cleanReason(reason);
    const user = await loadUser(userId);
    assertConfirmEmail(confirmEmail, user.email);
    if (user.id === staff.userId) throw fail(409, "You can't suspend yourself.");
    if (await StaffService.roleOf(user.id)) throw fail(409, "Staff can't be suspended. Remove their staff access first.");
    if (user.suspendedAt) throw fail(409, "Already suspended.");

    // suspendedAt first: a sign-in racing the revoke is refused by SessionService.create.
    const [changed] = await User.update({ suspendedAt: new Date() }, { where: { id: user.id, suspendedAt: null } });
    if (!changed) throw fail(409, "Already suspended.");
    // The suspension is logged even if revoking the sessions fails.
    try {
      await SessionService.revokeAll(user.id);
    } finally {
      await AdminActionService.record({ staff: actor(staff), action: "user_suspended", targetUserId: user.id, reason: why, req });
    }
    await tellUser(user, "2keevo support suspended your account.");
  }

  static async unsuspend(staff: Staff, userId: number, reason: unknown, req: Request) {
    const why = cleanReason(reason);
    const user = await loadUser(userId);
    if (!user.suspendedAt) throw fail(409, "Not suspended.");

    const [changed] = await User.update({ suspendedAt: null }, { where: { id: user.id, suspendedAt: { [Op.ne]: null } } });
    if (!changed) throw fail(409, "Not suspended.");
    await AdminActionService.record({ staff: actor(staff), action: "user_unsuspended", targetUserId: user.id, reason: why, req });
    await tellUser(user, "2keevo support restored your account.");
  }

  /** The old owner stays on as an admin. */
  static async transferCompanyOwnership(
    staff: Staff,
    companyId: number,
    newOwnerUserId: number,
    reason: unknown,
    req: Request
  ) {
    const why = cleanReason(reason);
    const company = await Company.findByPk(companyId, { attributes: ["id", "name"] });
    if (!company) throw fail(404, "Company not found.");
    const newOwner = await User.findByPk(newOwnerUserId, { attributes: ["id", "email"] });
    if (!newOwner) throw fail(404, "User not found.");

    const owner = await CompanyMember.findOne({
      where: { companyId, role: "owner", status: "active" },
      attributes: ["id", "userId"],
    });
    if (owner && owner.userId === newOwner.id) throw fail(409, "That user is already the owner.");
    const member = await CompanyMember.findOne({
      where: { companyId, userId: newOwner.id },
      attributes: ["id", "status"],
    });
    if (!member || member.status !== "active") throw fail(409, "The new owner must be an active member.");
    const oldOwner = owner?.userId ? await User.findByPk(owner.userId, { attributes: ["id", "email"] }) : null;

    await sequelize.transaction(async (transaction) => {
      if (owner) await CompanyMember.update({ role: "admin" }, { where: { id: owner.id }, transaction });
      await CompanyMember.update({ role: "owner" }, { where: { id: member.id }, transaction });
    });
    await AdminActionService.record({
      staff: actor(staff),
      action: "company_owner_transferred",
      targetCompanyId: company.id,
      targetUserId: newOwner.id,
      reason: why,
      details: { fromUserId: oldOwner?.id ?? null, toUserId: newOwner.id },
      req,
    });
    await tellUser(newOwner, `2keevo support made you the owner of ${company.name}.`, company.id);
    if (oldOwner) {
      await tellUser(oldOwner, `2keevo support moved ownership of ${company.name} to ${newOwner.email}.`, company.id);
    }
  }
}

export default SupportActionService;
