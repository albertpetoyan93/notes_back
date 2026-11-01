import { Op, QueryTypes, WhereOptions, col, fn, literal } from "sequelize";
import { CompanyDetail, CompanyRow, SubscriptionInput, toCompanyDetail, toCompanyRow } from "../../admin/dto";
import sequelize from "../../configs/DB/sequelize";
import Company from "../../models/Company";
import CompanyMember from "../../models/CompanyMember";
import Subscription from "../../models/Subscription";
import User from "../../models/User";
import { escapeLike } from "./AdminUsersService";

const PAGE_SIZE = 50;
// Keeps the offset a safe integer.
const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE);

export interface CompanyListFilter {
  q?: string;
  page?: number;
}

const LIST_ATTRIBUTES = ["id", "name", "status", "suspendedAt", "markedForRemovalAt", "discount", "createdAt"];

// The detail page also needs the policies and whether a recovery key is set; the key
// itself is never read (the flag is computed in SQL).
const DETAIL_ATTRIBUTES: (string | [ReturnType<typeof literal>, string])[] = [
  ...LIST_ATTRIBUTES,
  "policies",
  [literal(`("recoveryPublicKey" IS NOT NULL)`), "hasRecoveryKey"],
];

// Stripe ids are never read: only whether one is set, worked out in SQL.
const SUBSCRIPTION_ATTRIBUTES: (string | [ReturnType<typeof literal>, string])[] = [
  "id",
  "companyId",
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

const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2 };

type Owner = { userId: number; email: string };

const subscriptionInput = (row: unknown): SubscriptionInput => {
  const { companyId: _companyId, stripeManaged, ...rest } = row as SubscriptionInput & {
    companyId: number;
    stripeManaged: boolean;
  };
  // The DTO only checks that an id is set, so hand it a marker instead of a real id.
  return { ...rest, stripeSubscriptionId: stripeManaged ? "set" : null };
};

/** The company's Team subscription (latest first, like BillingService), for each company id. */
async function subscriptionsFor(companyIds: number[]): Promise<Map<number, SubscriptionInput>> {
  const result = new Map<number, SubscriptionInput>();
  if (!companyIds.length) return result;
  const rows = (await Subscription.findAll({
    where: { companyId: { [Op.in]: companyIds }, plan: "team" },
    attributes: SUBSCRIPTION_ATTRIBUTES,
    order: [
      ["updatedAt", "DESC"],
      ["id", "DESC"],
    ],
    raw: true,
  })) as unknown as { companyId: number }[];
  for (const row of rows) {
    if (!result.has(row.companyId)) result.set(row.companyId, subscriptionInput(row));
  }
  return result;
}

/** Active members per company: the same definition as the billing page's `members`. */
async function seatsFor(companyIds: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (!companyIds.length) return result;
  const rows = (await CompanyMember.findAll({
    where: { companyId: { [Op.in]: companyIds }, status: "active" },
    attributes: ["companyId", [fn("COUNT", col("id")), "count"]],
    group: ["companyId"],
    raw: true,
  })) as unknown as { companyId: number | string; count: string | number }[];
  for (const row of rows) result.set(Number(row.companyId), Number(row.count));
  return result;
}

/** The owner's id and email, for each company id. */
async function ownersFor(companyIds: number[]): Promise<Map<number, Owner>> {
  const result = new Map<number, Owner>();
  if (!companyIds.length) return result;
  const rows = (await CompanyMember.findAll({
    where: { companyId: { [Op.in]: companyIds }, role: "owner", status: "active", userId: { [Op.ne]: null } },
    attributes: ["companyId", "userId", "email"],
    order: [["id", "ASC"]],
    raw: true,
  })) as unknown as { companyId: number; userId: number; email: string }[];
  for (const row of rows) {
    if (!result.has(row.companyId)) result.set(row.companyId, { userId: row.userId, email: row.email });
  }
  return result;
}

class AdminCompaniesService {
  static async list(filter: CompanyListFilter): Promise<{ rows: CompanyRow[]; total: number }> {
    const q = typeof filter.q === "string" ? filter.q.trim() : "";
    const where: WhereOptions = q ? { name: { [Op.iLike]: `${escapeLike(q)}%` } } : {};
    const page = Number.isFinite(filter.page) ? Math.min(Math.max(1, Math.floor(filter.page!)), MAX_PAGE) : 1;
    const { rows, count } = await Company.findAndCountAll({
      where,
      attributes: LIST_ATTRIBUTES,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });

    const ids = rows.map((company) => company.id);
    const [owners, seats, subscriptions] = await Promise.all([ownersFor(ids), seatsFor(ids), subscriptionsFor(ids)]);

    return {
      rows: rows.map((company) =>
        toCompanyRow(company, {
          owner: owners.get(company.id) ?? null,
          seatsUsed: seats.get(company.id) ?? 0,
          subscription: subscriptions.get(company.id) ?? null,
        })
      ),
      total: typeof count === "number" ? count : (count as unknown[]).length,
    };
  }

  /** null when there is no such company. Recording the view is the controller's job. */
  static async detail(companyId: number): Promise<CompanyDetail | null> {
    const company = (await Company.findByPk(companyId, { attributes: DETAIL_ATTRIBUTES, raw: true })) as unknown as
      | (Parameters<typeof toCompanyDetail>[0]["company"] & { hasRecoveryKey: boolean })
      | null;
    if (!company) return null;

    const [memberRows, seats, subscriptions, groups] = await Promise.all([
      // Invited and active people (not removed). From User only the id, email and 2FA flag.
      CompanyMember.findAll({
        where: { companyId, status: { [Op.ne]: "removed" } },
        attributes: ["id", "userId", "email", "role", "status", "createdAt"],
        include: [{ model: User, as: "user", attributes: ["id", "email", "twoFactorEnabled"], required: false }],
        order: [
          ["email", "ASC"],
          ["id", "ASC"],
        ],
      }),
      seatsFor([companyId]),
      subscriptionsFor([companyId]),
      // Names and counts only; active members, like GroupService.memberCounts.
      sequelize.query<{ id: number; name: string; members: string | number }>(
        `SELECT g."id", g."name", COUNT(c."id") AS members
           FROM "company_groups" g
           LEFT JOIN "company_group_members" m ON m."groupId" = g."id"
           LEFT JOIN "company_members" c ON c."companyId" = g."companyId" AND c."userId" = m."userId" AND c."status" = 'active'
          WHERE g."companyId" = :companyId
          GROUP BY g."id", g."name"
          ORDER BY g."name" ASC, g."id" ASC`,
        { replacements: { companyId }, type: QueryTypes.SELECT }
      ),
    ]);

    // Owner first, then admins, then members; email order within a role.
    const members = memberRows
      .map((member) => ({
        userId: member.userId ?? null,
        email: member.email,
        role: member.role,
        status: member.status,
        createdAt: member.createdAt,
        twoFactorEnabled: (member as unknown as { user?: { twoFactorEnabled?: boolean } | null }).user?.twoFactorEnabled,
      }))
      .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
    const owner = members.find((member) => member.role === "owner" && member.status === "active" && member.userId != null);

    return toCompanyDetail({
      company: { ...company, recoveryPublicKey: company.hasRecoveryKey ? "set" : null },
      owner: owner ? { userId: owner.userId as number, email: owner.email } : null,
      seatsUsed: seats.get(companyId) ?? 0,
      subscription: subscriptions.get(companyId) ?? null,
      members,
      groups: groups.map((group) => ({ id: group.id, name: group.name, members: Number(group.members) })),
    });
  }
}

export default AdminCompaniesService;
