import { Op } from "sequelize";
import { PLANS, PlanId, PlanLimits, UNLOCKED_BY } from "../common/plans";
import CompanyMember from "../models/CompanyMember";
import FamilyMember from "../models/FamilyMember";
import Subscription from "../models/Subscription";

/**
 * What a person or company may do, from their subscriptions. Payment providers only
 * report who paid; this decides what that unlocks.
 */

export interface Entitlement {
  plan: PlanId;
  /** Where the plan comes from: their own subscription, a company's Team, a family they joined, or nothing. */
  source: "own" | "team" | "family" | "free";
  /** The company whose Team covers them, when source is "team". */
  companyId?: number;
  /** The organizer whose Family covers them, when source is "family". */
  familyOwnerId?: number;
  limits: PlanLimits;
  subscription: Subscription | null;
}

/** A plan limit was reached. 402, with a code the apps turn into an upgrade prompt. */
export class PlanLimitError extends Error {
  status = 402;
  code = "plan_limit";
  constructor(
    message: string,
    public feature: keyof PlanLimits,
    public plan: PlanId = UNLOCKED_BY
  ) {
    super(message);
  }
}

export const planLimitBody = (error: PlanLimitError) => ({
  message: error.message,
  code: error.code,
  feature: error.feature,
  plan: error.plan,
});

/**
 * Does this subscription unlock its plan right now?
 * - trial: until it ends
 * - active: yes
 * - payment failed: during the grace period
 * - cancelled: until the end of the period already paid for
 * Keep in step with the SQL copy (`LIVE`) in services/admin/AdminUsersService.ts.
 */
export function isLive(subscription: Subscription, now = new Date()) {
  const after = (date?: Date | null) => !!date && new Date(date).getTime() > now.getTime();
  switch (subscription.status) {
    case "trialing":
      return after(subscription.trialEndsAt);
    case "active":
      return true;
    case "past_due":
      return !subscription.graceEndsAt || after(subscription.graceEndsAt);
    case "canceled":
      return after(subscription.currentPeriodEnd);
    default:
      return false;
  }
}

export const best = (subscriptions: Subscription[], now: Date) =>
  subscriptions
    .filter((subscription) => isLive(subscription, now))
    .sort((a, b) => PLANS[b.plan].rank - PLANS[a.plan].rank)[0] || null;

/** Which source wins for a person, given the best live subscription from each. Also used by the admin users list. */
export function decidePlan(
  own: Subscription | null,
  family: Subscription | null,
  familyMembership: { ownerId: number } | null,
  team: Subscription | null
): Entitlement["source"] {
  if (own && (!team || PLANS[own.plan].rank >= PLANS[team.plan].rank) && (!family || own.plan === "family")) return "own";
  if (family && familyMembership) return "family";
  if (team) return "team";
  return "free";
}

const FREE = (): Entitlement => ({
  plan: "free",
  source: "free",
  limits: PLANS.free.limits,
  subscription: null,
});

class EntitlementService {
  /** The company's Team subscription, when it is live. */
  async forCompany(companyId: number, now = new Date()) {
    const rows = await Subscription.findAll({ where: { companyId, plan: "team" } });
    return best(rows, now);
  }

  /** The organizer's Family subscription, when it is live. */
  async forFamily(ownerId: number, now = new Date()) {
    const rows = await Subscription.findAll({ where: { userId: ownerId, plan: "family" } });
    return best(rows, now);
  }

  /**
   * The best of: their own subscription, a Family they joined, or a Team from a company
   * they are an active member of.
   */
  async forUser(userId: number, now = new Date()): Promise<Entitlement> {
    const own = best(await Subscription.findAll({ where: { userId } }), now);

    const membership = await FamilyMember.findOne({
      where: { userId, status: "active" },
      attributes: ["ownerId"],
    });
    const family = membership ? await this.forFamily(membership.ownerId, now) : null;

    const memberships = await CompanyMember.findAll({
      where: { userId, status: "active" },
      attributes: ["companyId"],
    });
    const companyIds = memberships.map((member) => member.companyId);
    const team = companyIds.length
      ? best(
          await Subscription.findAll({
            where: { companyId: { [Op.in]: companyIds }, plan: "team" },
          }),
          now
        )
      : null;

    const source = decidePlan(own, family, membership, team);
    if (source === "own" && own) {
      return { plan: own.plan, source: "own", limits: PLANS[own.plan].limits, subscription: own };
    }
    if (source === "family" && family && membership) {
      return {
        plan: "family",
        source: "family",
        familyOwnerId: membership.ownerId,
        limits: PLANS.family.limits,
        subscription: family,
      };
    }
    if (source === "team" && team) {
      return {
        plan: "team",
        source: "team",
        companyId: team.companyId ?? undefined,
        limits: PLANS.team.limits,
        subscription: team,
      };
    }
    return FREE();
  }

  /* Checks used where something new is created. Existing collections and shares are
     never touched: over a limit after a downgrade, they keep working. */

  async assertCanCreateCollection(userId: number, ownedPersonal: number) {
    const { limits } = await this.forUser(userId);
    if (limits.collections !== null && ownedPersonal >= limits.collections) {
      throw new PlanLimitError(
        `The Free plan includes ${limits.collections} collections. Upgrade to Premium for unlimited collections.`,
        "collections"
      );
    }
  }

  async assertCanShareWith(userId: number, alreadyShared: number, adding: number) {
    const { limits } = await this.forUser(userId);
    if (adding > 0 && limits.sharePeople !== null && alreadyShared + adding > limits.sharePeople) {
      throw new PlanLimitError(
        `On the Free plan, something can be shared with up to ${limits.sharePeople} people. Upgrade to Premium to share with more.`,
        "sharePeople"
      );
    }
  }

  async assertCanUseShareExpiry(userId: number) {
    const { limits } = await this.forUser(userId);
    if (!limits.shareExpiry) {
      throw new PlanLimitError(
        "Shares that end on a date are part of Premium. Share without an end date, or upgrade.",
        "shareExpiry"
      );
    }
  }

  async hasPasswordHealth(userId: number) {
    return (await this.forUser(userId)).limits.passwordHealth;
  }
}

export default new EntitlementService();
