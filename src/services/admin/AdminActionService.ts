import type { Request } from "express";
import { Op, Transaction, WhereOptions } from "sequelize";
import { AdminActionRow, toAdminActionRow } from "../../admin/dto";
import AdminAction from "../../models/AdminAction";
import type { StaffRole } from "../../models/AdminStaff";
import User from "../../models/User";

export type AdminActionName =
  | "admin_sign_in"
  | "admin_sign_in_failed"
  | "viewed_user"
  | "viewed_company"
  | "password_reset_sent"
  | "sessions_revoked"
  | "user_suspended"
  | "user_unsuspended"
  | "remove_2fa_requested"
  | "remove_2fa_cancelled"
  | "remove_2fa_confirmed"
  | "company_owner_transferred"
  | "subscription_cancelled"
  | "payment_refunded"
  | "plan_changed"
  | "trial_extended"
  | "discount_approved"
  | "discount_declined"
  | "discount_removed"
  | "staff_added"
  | "staff_changed";

export interface RecordInput {
  /** null for system events, such as a failed sign-in by someone who is not staff. */
  staff: { userId: number; email: string; role: StaffRole } | null;
  action: AdminActionName;
  targetUserId?: number;
  targetCompanyId?: number;
  reason?: string;
  /** Allow-listed scalars only; stored as given. */
  details?: Record<string, string | number | boolean | null>;
  req?: Request;
  /** Writes the row inside the caller's transaction, so it rolls back with it. */
  transaction?: Transaction;
}

export interface ListFilter {
  staffUserId?: number;
  action?: AdminActionName;
  targetUserId?: number;
  targetCompanyId?: number;
  from?: Date;
  to?: Date;
  page?: number;
}

const PAGE_SIZE = 50;
const VIEW_DEDUPE_MS = 10 * 60 * 1000;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Trimmed reason, max 500 chars; support and billing actions need one. */
export function cleanReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim().slice(0, 500).trim() : "";
  if (!reason) throw fail(400, "Give a reason.");
  return reason;
}

/** Suspend and 2FA removal: staff must type the user's email. */
export function assertConfirmEmail(typed: unknown, actual: string): void {
  if (typeof typed !== "string" || typed.trim().toLowerCase() !== actual.trim().toLowerCase()) {
    throw fail(400, "Type the user's email to confirm.");
  }
}

class AdminActionService {
  static async record(input: RecordInput): Promise<void> {
    const inTx = input.transaction ? { transaction: input.transaction } : {};
    // Snapshot the email so the log stays readable if the user changes it later.
    const target = input.targetUserId
      ? await User.findByPk(input.targetUserId, { attributes: ["email"], ...inTx })
      : null;
    const row = {
      staffUserId: input.staff?.userId ?? null,
      staffEmail: input.staff?.email ?? "",
      role: input.staff?.role ?? null,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
      targetEmail: target?.email ?? null,
      targetCompanyId: input.targetCompanyId ?? null,
      reason: input.reason ?? null,
      details: input.details ?? {},
      ip: input.req?.ip?.slice(0, 100) ?? null,
      userAgent: input.req?.get("user-agent")?.slice(0, 500) ?? null,
    };
    if (input.transaction) await AdminAction.create(row, inTx);
    else await AdminAction.create(row);
  }

  /**
   * Detail-page views: one row per staff member and target per 10 minutes,
   * so reloads after an action (and React's double fetch in dev) don't flood the log.
   */
  static async recordView(
    input: RecordInput & { action: "viewed_user" | "viewed_company" }
  ): Promise<void> {
    const recent = await AdminAction.findOne({
      attributes: ["id"],
      where: {
        staffUserId: input.staff?.userId ?? null,
        action: input.action,
        ...(input.targetUserId !== undefined ? { targetUserId: input.targetUserId } : {}),
        ...(input.targetCompanyId !== undefined ? { targetCompanyId: input.targetCompanyId } : {}),
        createdAt: { [Op.gte]: new Date(Date.now() - VIEW_DEDUPE_MS) },
      },
    });
    if (!recent) await AdminActionService.record(input);
  }

  static async list(filter: ListFilter): Promise<{ rows: AdminActionRow[]; total: number }> {
    const where: WhereOptions = {};
    const w = where as Record<string, unknown>;
    if (filter.staffUserId !== undefined) w.staffUserId = filter.staffUserId;
    if (filter.action) w.action = filter.action;
    if (filter.targetUserId !== undefined) w.targetUserId = filter.targetUserId;
    if (filter.targetCompanyId !== undefined) w.targetCompanyId = filter.targetCompanyId;
    if (filter.from || filter.to) {
      w.createdAt = {
        ...(filter.from ? { [Op.gte]: filter.from } : {}),
        ...(filter.to ? { [Op.lte]: filter.to } : {}),
      };
    }
    const page = Math.max(1, Math.floor(filter.page ?? 1) || 1);
    const { rows, count } = await AdminAction.findAndCountAll({
      where,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    return { rows: rows.map(toAdminActionRow), total: count };
  }
}

export default AdminActionService;
