import { Op, WhereOptions, col, fn, literal } from "sequelize";
import {
  AdminActionInput,
  UserDetail,
  UserDetailParts,
  UserRow,
  toUserDetail,
  toUserRow,
} from "../../admin/dto";
import { PLANS, PlanId } from "../../common/plans";
import { best, decidePlan } from "../EntitlementService";
import Attachment from "../../models/Attachment";
import AuditEvent from "../../models/AuditEvent";
import Collection from "../../models/Collection";
import CollectionShare from "../../models/CollectionShare";
import Company from "../../models/Company";
import CompanyMember from "../../models/CompanyMember";
import EmergencyContact from "../../models/EmergencyContact";
import FamilyMember from "../../models/FamilyMember";
import Note from "../../models/Note";
import NoteShare from "../../models/NoteShare";
import Subscription from "../../models/Subscription";
import SupportRequest from "../../models/SupportRequest";
import User from "../../models/User";
import UserActivityDay from "../../models/UserActivityDay";
import UserPasskey from "../../models/UserPasskey";
import UserSession from "../../models/UserSession";
import { USER_ACTIVITY_ACTIONS } from "../AuditService";
import { utcDate } from "../ActivityService";
import AdminActionService from "./AdminActionService";

const PAGE_SIZE = 50;
const ACTIVITY_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// About ten years: beyond that the cutoff date is meaningless (and can overflow Date).
const MAX_INACTIVE_DAYS = 3650;
// Keeps the offset a safe integer.
const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE);

export interface UserListFilter {
  q?: string;
  plan?: string;
  e2e?: boolean;
  twoFactor?: boolean;
  status?: "active" | "suspended";
  /** YYYY-MM-DD, UTC, inclusive. */
  signedUpFrom?: string;
  signedUpTo?: string;
  inactiveDays?: number;
  page?: number;
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Makes %, _ and \ match themselves in LIKE (Postgres escapes with a backslash). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

function parseDay(value: string, edge: "start" | "end"): Date {
  const date = DAY.test(value) ? new Date(`${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`) : null;
  if (!date || Number.isNaN(date.getTime())) throw fail(400, "Dates look like 2026-01-31.");
  return date;
}

// A subscription that unlocks its plan right now: the SQL twin of isLive() in EntitlementService.
const LIVE = `(s."status" = 'active'
  OR (s."status" = 'trialing' AND s."trialEndsAt" > NOW())
  OR (s."status" = 'past_due' AND (s."graceEndsAt" IS NULL OR s."graceEndsAt" > NOW()))
  OR (s."status" = 'canceled' AND s."currentPeriodEnd" > NOW()))`;

// Ids of everyone a live subscription covers: their own, the Family they joined, a Team
// they are an active member of. `plan` is checked against PLANS before it gets here.
const coveredBy = (plan: PlanId | null) => {
  const parts = [
    `SELECT s."userId" FROM "subscriptions" s
      WHERE s."userId" IS NOT NULL ${plan ? `AND s."plan" = '${plan}'` : ""} AND ${LIVE}`,
  ];
  if (!plan || plan === "family") {
    parts.push(`SELECT fm."userId" FROM "family_members" fm
      JOIN "subscriptions" s ON s."userId" = fm."ownerId" AND s."plan" = 'family'
      WHERE fm."status" = 'active' AND fm."userId" IS NOT NULL AND ${LIVE}`);
  }
  if (!plan || plan === "team") {
    parts.push(`SELECT cm."userId" FROM "company_members" cm
      JOIN "subscriptions" s ON s."companyId" = cm."companyId" AND s."plan" = 'team'
      WHERE cm."status" = 'active' AND cm."userId" IS NOT NULL AND ${LIVE}`);
  }
  return parts.join("\n  UNION\n  ");
};

function planFilter(plan: string) {
  if (!Object.prototype.hasOwnProperty.call(PLANS, plan)) throw fail(400, "Unknown plan.");
  if (plan === "free") return { id: { [Op.notIn]: literal(`(${coveredBy(null)})`) } };
  return { id: { [Op.in]: literal(`(${coveredBy(plan as PlanId)})`) } };
}

function buildWhere(filter: UserListFilter): WhereOptions {
  const all: WhereOptions[] = [];

  const q = typeof filter.q === "string" ? filter.q.trim() : "";
  if (q) {
    const like = { [Op.iLike]: `${escapeLike(q)}%` };
    all.push({ [Op.or]: [{ email: like }, { fullName: like }, { username: like }] });
  }
  if (filter.plan) all.push(planFilter(filter.plan));
  if (filter.e2e !== undefined) all.push({ e2eEnabled: filter.e2e });
  if (filter.twoFactor !== undefined) all.push({ twoFactorEnabled: filter.twoFactor });
  if (filter.status === "suspended") all.push({ suspendedAt: { [Op.ne]: null } });
  if (filter.status === "active") all.push({ suspendedAt: null });
  if (filter.signedUpFrom || filter.signedUpTo) {
    all.push({
      createdAt: {
        ...(filter.signedUpFrom ? { [Op.gte]: parseDay(filter.signedUpFrom, "start") } : {}),
        ...(filter.signedUpTo ? { [Op.lte]: parseDay(filter.signedUpTo, "end") } : {}),
      },
    });
  }
  if (filter.inactiveDays !== undefined) {
    const days = filter.inactiveDays;
    if (!Number.isInteger(days) || days < 0 || days > MAX_INACTIVE_DAYS) {
      throw fail(400, `Inactive days must be a whole number from 0 to ${MAX_INACTIVE_DAYS}.`);
    }
    // The cutoff is a date we formatted ourselves, never text from the request.
    const cutoff = utcDate(new Date(Date.now() - days * DAY_MS));
    all.push({
      id: {
        [Op.notIn]: literal(`(SELECT "userId" FROM "user_activity_days" WHERE "date" >= '${cutoff}')`),
      },
    });
  }

  return all.length ? { [Op.and]: all } : {};
}

/**
 * Plan per user for a whole page in five queries. The rules are EntitlementService's own
 * (`best`, `decidePlan`), so this can't drift from forUser.
 */
async function plansFor(userIds: number[], now = new Date()): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (!userIds.length) return result;

  const subscriptionColumns = ["userId", "companyId", "plan", "status", "trialEndsAt", "currentPeriodEnd", "graceEndsAt"];
  const [ownRows, familyMembers, companyMembers] = await Promise.all([
    Subscription.findAll({ where: { userId: { [Op.in]: userIds } }, attributes: subscriptionColumns, raw: true }),
    FamilyMember.findAll({ where: { userId: { [Op.in]: userIds }, status: "active" }, attributes: ["userId", "ownerId"], raw: true }),
    CompanyMember.findAll({ where: { userId: { [Op.in]: userIds }, status: "active" }, attributes: ["userId", "companyId"], raw: true }),
  ]);
  const ownerIds = [...new Set(familyMembers.map((member) => member.ownerId))];
  const companyIds = [...new Set(companyMembers.map((member) => member.companyId))];
  const [familyRows, teamRows] = await Promise.all([
    ownerIds.length
      ? Subscription.findAll({ where: { userId: { [Op.in]: ownerIds }, plan: "family" }, attributes: subscriptionColumns, raw: true })
      : [],
    companyIds.length
      ? Subscription.findAll({ where: { companyId: { [Op.in]: companyIds }, plan: "team" }, attributes: subscriptionColumns, raw: true })
      : [],
  ]);

  for (const userId of userIds) {
    const own = best(ownRows.filter((row) => row.userId === userId), now);
    const membership = familyMembers.find((member) => member.userId === userId) ?? null;
    const family = membership ? best(familyRows.filter((row) => row.userId === membership.ownerId), now) : null;
    const memberCompanies = companyMembers.filter((member) => member.userId === userId).map((member) => member.companyId);
    const team = memberCompanies.length
      ? best(teamRows.filter((row) => row.companyId != null && memberCompanies.includes(row.companyId)), now)
      : null;

    const source = decidePlan(own, family, membership, team);
    const plan: PlanId = source === "own" && own ? own.plan : source === "family" ? "family" : source === "team" ? "team" : "free";
    result.set(userId, plan);
  }
  return result;
}

// Fields the user page needs, read as booleans/counts in SQL so the secret columns
// (recovery codes, recovery key) never leave the database.
const DETAIL_USER_ATTRIBUTES: (string | [ReturnType<typeof literal>, string])[] = [
  "id",
  "email",
  "username",
  "fullName",
  "createdAt",
  "suspendedAt",
  "e2eEnabled",
  "twoFactorEnabled",
  "mustChangeMasterPassword",
  "passwordResetExpires",
  [
    literal(
      `CASE WHEN jsonb_typeof("twoFactorRecoveryCodes") = 'array' THEN jsonb_array_length("twoFactorRecoveryCodes") ELSE 0 END`
    ),
    "recoveryCodesLeft",
  ],
  [literal(`("recoveryProtectedUserKey" IS NOT NULL)`), "hasRecoveryKey"],
];

const SUBSCRIPTION_ATTRIBUTES: (string | [ReturnType<typeof literal>, string])[] = [
  "id",
  "plan",
  "interval",
  "status",
  "seats",
  "trialEndsAt",
  "currentPeriodEnd",
  "cancelAtPeriodEnd",
  "graceEndsAt",
  [literal(`("stripeSubscriptionId" IS NOT NULL)`), "stripeManaged"],
];

class AdminUsersService {
  static async list(filter: UserListFilter): Promise<{ rows: UserRow[]; total: number }> {
    const where = buildWhere(filter);
    const page = Number.isFinite(filter.page) ? Math.min(Math.max(1, Math.floor(filter.page!)), MAX_PAGE) : 1;
    const { rows, count } = await User.findAndCountAll({
      where,
      attributes: ["id", "email", "username", "fullName", "createdAt", "suspendedAt", "e2eEnabled", "twoFactorEnabled"],
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });

    const ids = rows.map((user) => user.id);
    const [plans, activity] = await Promise.all([
      plansFor(ids),
      ids.length
        ? UserActivityDay.findAll({
            where: { userId: { [Op.in]: ids } },
            attributes: ["userId", [fn("MAX", col("date")), "lastDate"]],
            group: ["userId"],
            raw: true,
          })
        : [],
    ]);
    const lastActive = new Map<number, string>();
    for (const row of activity as unknown as { userId: number | string; lastDate: string | Date }[]) {
      lastActive.set(Number(row.userId), new Date(row.lastDate).toISOString());
    }

    return {
      rows: rows.map((user) =>
        toUserRow(user, { plan: plans.get(user.id) ?? "free", lastActive: lastActive.get(user.id) ?? null })
      ),
      total: typeof count === "number" ? count : (count as unknown[]).length,
    };
  }

  /** null when there is no such user. Recording the view is the controller's job. */
  static async detail(userId: number): Promise<UserDetail | null> {
    const user = (await User.findByPk(userId, { attributes: DETAIL_USER_ATTRIBUTES, raw: true })) as unknown as
      | (UserDetailParts["user"] & { recoveryCodesLeft: number | string; hasRecoveryKey: boolean })
      | null;
    if (!user) return null;

    const [
      passkeys,
      emergencyContacts,
      sessions,
      noteCounts,
      lastItemChangeAt,
      collections,
      noteSharesSent,
      collectionSharesSent,
      noteSharesReceived,
      collectionSharesReceived,
      attachmentBytes,
      subscriptions,
      memberships,
      activity,
      staffActions,
      supportRequests,
    ] = await Promise.all([
      UserPasskey.findAll({ where: { userId }, attributes: ["name", "lastUsedAt", "createdAt"], order: [["createdAt", "ASC"]] }),
      EmergencyContact.count({ where: { grantorId: userId } }),
      UserSession.findAll({
        where: { userId, expiresAt: { [Op.gt]: new Date() } },
        attributes: ["id", "kind", "userAgent", "ip", "createdAt", "lastUsedAt", "lastActiveAt", "lockedAt", "extensionVersion"],
        order: [["lastUsedAt", "DESC"]],
      }),
      // Only the category and how many; never titles or content.
      Note.findAll({
        where: { userId, deletedAt: null },
        attributes: ["category", [fn("COUNT", col("*")), "count"]],
        group: ["category"],
        raw: true,
      }),
      Note.max("updatedAt", { where: { userId }, paranoid: false }),
      Collection.count({ where: { userId } }),
      NoteShare.count({ where: { sharedByUserId: userId } }),
      CollectionShare.count({ where: { sharedByUserId: userId } }),
      NoteShare.count({ where: { sharedWithUserId: userId } }),
      CollectionShare.count({ where: { sharedWithUserId: userId } }),
      Attachment.sum("size", { where: { ownerUserId: userId } }),
      Subscription.findAll({ where: { userId }, attributes: SUBSCRIPTION_ATTRIBUTES, order: [["createdAt", "DESC"]], raw: true }),
      CompanyMember.findAll({
        where: { userId, status: "active" },
        attributes: ["companyId", "role"],
        include: [{ model: Company, as: "company", attributes: ["name"], required: true }],
      }),
      // Action and time only: no details, no ids, no IP.
      AuditEvent.findAll({
        where: { actorId: userId, action: { [Op.in]: USER_ACTIVITY_ACTIONS } },
        attributes: ["action", "createdAt"],
        order: [
          ["createdAt", "DESC"],
          ["id", "DESC"],
        ],
        limit: ACTIVITY_LIMIT,
      }),
      AdminActionService.list({ targetUserId: userId }),
      SupportRequest.findAll({
        where: { userId },
        attributes: ["id", "kind", "status", "createdAt", "expiresAt"],
        order: [
          ["createdAt", "DESC"],
          ["id", "DESC"],
        ],
      }),
    ]);

    const itemsByCategory: Record<string, number> = {};
    for (const row of noteCounts as unknown as { category: string; count: string | number }[]) {
      itemsByCategory[row.category] = Number(row.count);
    }

    return toUserDetail({
      user: {
        ...user,
        // The DTO only reads the length / whether it is set, so hand it just that.
        twoFactorRecoveryCodes: new Array(Number(user.recoveryCodesLeft) || 0).fill(null),
        recoveryProtectedUserKey: user.hasRecoveryKey ? "set" : null,
      },
      passkeys,
      emergencyContacts,
      sessions,
      usage: {
        itemsByCategory,
        collections,
        sharesSent: noteSharesSent + collectionSharesSent,
        sharesReceived: noteSharesReceived + collectionSharesReceived,
        attachmentBytes: Number(attachmentBytes || 0),
        lastItemChangeAt: lastItemChangeAt as Date | null | undefined,
      },
      subscriptions: (subscriptions as unknown as (Omit<UserDetailParts["subscriptions"][number], "stripeSubscriptionId"> & { stripeManaged: boolean })[]).map(
        (s) => ({ ...s, stripeSubscriptionId: s.stripeManaged ? "set" : null })
      ),
      companies: memberships.map((member) => ({
        id: member.companyId,
        name: (member as unknown as { company: { name: string } }).company.name,
        role: member.role,
      })),
      activity,
      // The list already returns finished rows; the DTO takes model-shaped ones.
      staffActions: staffActions.rows.map(
        (row): AdminActionInput => ({
          id: row.id,
          createdAt: new Date(row.at),
          staffEmail: row.staffEmail,
          role: row.role,
          action: row.action,
          targetUserId: row.targetUserId,
          targetEmail: row.targetEmail,
          targetCompanyId: row.targetCompanyId,
          reason: row.reason,
          details: row.details,
        })
      ),
      supportRequests,
    });
  }
}

export default AdminUsersService;
