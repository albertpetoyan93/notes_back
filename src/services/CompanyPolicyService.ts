import { Op } from "sequelize";
import Company, { CompanyPolicies } from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import User from "../models/User";

export const POLICY_CHOICES = {
  minPasswordLength: [8, 12, 16, 20],
  maxSessionDays: [1, 7, 14, 30],
  maxIdleMinutes: [5, 15, 30, 60],
} as const;

type NumberPolicy = keyof typeof POLICY_CHOICES;

/** What a person's companies require of them. */
export interface UserRules {
  /** Companies whose items they can't open: 2FA is required and they don't use it. */
  blocked: Set<number>;
  maxIdleMinutes: number | null;
  maxSessionDays: number | null;
}

export class PolicyError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// The auth check runs on every request; a short cache keeps that to one
// query a minute. Changing a policy or 2FA clears it straight away.
const CACHE_MS = 30 * 1000;
const cache = new Map<number, { at: number; rules: UserRules }>();

const strictest = (values: (number | null | undefined)[]) => {
  const set = values.filter((value): value is number => typeof value === "number" && value > 0);
  return set.length ? Math.min(...set) : null;
};

class CompanyPolicyService {
  async forUser(userId: number): Promise<UserRules> {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules;

    const memberships = await CompanyMember.findAll({
      where: { userId, status: "active" },
      attributes: ["companyId"],
    });
    const companies = memberships.length
      ? await Company.findAll({
          where: { id: { [Op.in]: memberships.map((item) => item.companyId) }, status: "active" },
          attributes: ["id", "policies"],
        })
      : [];
    const needs2fa = companies.filter((company) => company.policies?.require2fa);
    let blocked = new Set<number>();
    if (needs2fa.length) {
      const user = await User.findByPk(userId, { attributes: ["id", "twoFactorEnabled"] });
      if (!user?.twoFactorEnabled) blocked = new Set(needs2fa.map((company) => company.id));
    }
    const rules: UserRules = {
      blocked,
      maxIdleMinutes: strictest(companies.map((company) => company.policies?.maxIdleMinutes)),
      maxSessionDays: strictest(companies.map((company) => company.policies?.maxSessionDays)),
    };
    cache.set(userId, { at: Date.now(), rules });
    return rules;
  }

  /** After a policy or 2FA change. Without a user, for everyone. */
  clear(userId?: number) {
    if (userId === undefined) cache.clear();
    else cache.delete(userId);
  }

  /** Auto-lock minutes after company rules: the stricter of the two; 0 = never. */
  effectiveAutoLock(own: number, rules: UserRules) {
    if (!rules.maxIdleMinutes) return own;
    return own > 0 ? Math.min(own, rules.maxIdleMinutes) : rules.maxIdleMinutes;
  }

  /** The longest minimum password length among these companies, or null. */
  async minPasswordLength(companyIds: number[]) {
    if (!companyIds.length) return null;
    const companies = await Company.findAll({
      where: { id: { [Op.in]: companyIds }, status: "active" },
      attributes: ["id", "name", "policies"],
    });
    let rule: { length: number; company: string } | null = null;
    for (const company of companies) {
      const length = company.policies?.minPasswordLength;
      if (length && (!rule || length > rule.length)) rule = { length, company: company.name };
    }
    return rule;
  }

  /** Only known policies, with allowed values. */
  clean(input: any): CompanyPolicies {
    const next: CompanyPolicies = { require2fa: Boolean(input?.require2fa) };
    for (const key of Object.keys(POLICY_CHOICES) as NumberPolicy[]) {
      const raw = input?.[key];
      if (raw === null || raw === undefined || raw === 0 || raw === "") {
        next[key] = null;
        continue;
      }
      const value = Number(raw);
      if (!(POLICY_CHOICES[key] as readonly number[]).includes(value)) {
        throw new PolicyError(`${key} must be one of ${POLICY_CHOICES[key].join(", ")}, or empty.`);
      }
      next[key] = value;
    }
    return next;
  }

  private async manager(companyId: number, userId: number) {
    const company = await Company.findByPk(companyId);
    if (!company || company.status !== "active") throw new PolicyError("Company not found", 404);
    const member = await CompanyMember.findOne({
      where: { companyId, userId, status: "active", role: { [Op.in]: ["owner", "admin"] } },
    });
    if (!member) throw new PolicyError("Only owners and admins can change company policies.", 403);
    return company;
  }

  /** Policies, plus who would lose access if 2FA were required. */
  async get(companyId: number, userId: number) {
    const company = await this.manager(companyId, userId);
    const members = await CompanyMember.findAll({
      where: { companyId, status: "active", userId: { [Op.not]: null } },
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "email", "username", "fullName", "twoFactorEnabled"],
        },
      ],
    });
    const without2fa = members
      .map((member) => member.get("user") as User | null)
      .filter((user): user is User => !!user && !user.twoFactorEnabled)
      .map((user) => ({ id: user.id, name: user.fullName || user.username, email: user.email }));
    return { policies: this.clean(company.policies || {}), without2fa };
  }

  async update(companyId: number, userId: number, input: any) {
    const company = await this.manager(companyId, userId);
    const before = this.clean(company.policies || {});
    const next = this.clean(input);
    if (next.require2fa && !before.require2fa) {
      const actor = await User.findByPk(userId, { attributes: ["id", "twoFactorEnabled"] });
      if (!actor?.twoFactorEnabled) {
        throw new PolicyError(
          "Turn on two-factor authentication for your own account first, in Security settings."
        );
      }
    }
    await company.update({ policies: next });
    this.clear();
    const changed = (Object.keys(next) as (keyof CompanyPolicies)[]).filter(
      (key) => (before[key] ?? null) !== (next[key] ?? null)
    );
    return { policies: next, changed, before };
  }
}

export default new CompanyPolicyService();
