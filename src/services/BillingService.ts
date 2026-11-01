import { Op, UniqueConstraintError } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Attachment from "../models/Attachment";
import {
  DISCOUNT_PERCENT,
  PLANS,
  PlanId,
  PRICES,
  TEAM_MIN_SEATS,
  TRIAL_DAYS,
  TRIAL_PLANS,
} from "../common/plans";
import Collection from "../models/Collection";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import DiscountRequest from "../models/DiscountRequest";
import FamilyMember from "../models/FamilyMember";
import Subscription from "../models/Subscription";
import TrialUsed from "../models/TrialUsed";
import User from "../models/User";
import EntitlementService, { isLive } from "./EntitlementService";

export class BillingError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A subscription as the apps see it: no payment provider ids. */
export function publicSubscription(subscription: Subscription | null) {
  if (!subscription) return null;
  return {
    id: subscription.id,
    plan: subscription.plan,
    status: subscription.status,
    interval: subscription.interval ?? null,
    seats: subscription.seats ?? null,
    trialEndsAt: subscription.trialEndsAt ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    graceEndsAt: subscription.graceEndsAt ?? null,
    live: isLive(subscription),
    /** Paid through Stripe (not a free trial): manage it in Stripe's portal. */
    paid: Boolean(subscription.stripeSubscriptionId),
  };
}

/** A company's nonprofit or school discount, approved or waiting for review. */
async function discountFor(
  companyId: number,
  discount: string | null | undefined,
) {
  if (discount)
    return {
      kind: discount,
      percent: DISCOUNT_PERCENT,
      status: "approved" as const,
    };
  const open = await DiscountRequest.findOne({
    where: { companyId, status: "pending" },
    attributes: ["kind"],
  });
  if (open)
    return {
      kind: open.kind,
      percent: DISCOUNT_PERCENT,
      status: "pending" as const,
    };
  return null;
}

class BillingService {
  /** Everything the Billing page shows for the signed-in person. */
  async summary(userId: number) {
    const entitlement = await EntitlementService.forUser(userId);
    const ownCollections = await Collection.count({
      where: { userId, companyId: { [Op.is]: null } },
    });
    const usedTrials = await TrialUsed.findAll({
      where: { userId },
      attributes: ["plan"],
    });
    const own = await Subscription.findOne({
      where: { userId },
      order: [["updatedAt", "DESC"]],
    });

    // Companies whose plan this person can see and change.
    const managed = await CompanyMember.findAll({
      where: {
        userId,
        status: "active",
        role: { [Op.in]: ["owner", "admin"] },
      },
      attributes: ["companyId", "role"],
    });
    const companies = await Promise.all(
      managed.map(async (member) => {
        const company = await Company.findByPk(member.companyId, {
          attributes: [
            "id",
            "name",
            "status",
            "suspendedAt",
            "markedForRemovalAt",
            "discount",
          ],
        });
        if (!company) return null;
        const team = await Subscription.findOne({
          where: { companyId: company.id, plan: "team" },
          order: [["updatedAt", "DESC"]],
        });
        const trialUsed = await TrialUsed.count({
          where: { companyId: company.id, plan: "team" },
        });
        const members = await CompanyMember.count({
          where: { companyId: company.id, status: "active" },
        });
        return {
          id: company.id,
          name: company.name,
          role: member.role,
          status: company.status,
          suspendedAt: company.suspendedAt ?? null,
          markedForRemovalAt: company.markedForRemovalAt ?? null,
          subscription: publicSubscription(team),
          members,
          billedSeats: Math.max(TEAM_MIN_SEATS, members),
          canStartTrial:
            member.role === "owner" && !trialUsed && !(team && isLive(team)),
          discount: await discountFor(company.id, company.discount),
        };
      }),
    );

    const familyOrganizer =
      entitlement.source === "family" && entitlement.familyOwnerId
        ? await User.findByPk(entitlement.familyOwnerId, {
            attributes: ["fullName", "username", "email"],
          })
        : null;

    // Every live Team the person belongs to (not only the one EntitlementService picks).
    const memberships = await CompanyMember.findAll({
      where: { userId, status: "active" },
      attributes: ["companyId"],
    });
    const teamCompanies = (
      await Promise.all(
        memberships.map(async (membership) => {
          const team = await EntitlementService.forCompany(membership.companyId);
          if (!team) return null;
          const company = await Company.findByPk(membership.companyId, {
            attributes: ["id", "name"],
          });
          return company ? { id: company.id, name: company.name } : null;
        })
      )
    ).filter(Boolean) as { id: number; name: string }[];

    const companyName =
      entitlement.source === "team"
        ? teamCompanies.map((company) => company.name).join(", ") ||
          (entitlement.companyId
            ? (
                await Company.findByPk(entitlement.companyId, {
                  attributes: ["name"],
                })
              )?.name || null
            : null)
        : null;

    return {
      plan: entitlement.plan,
      planName: PLANS[entitlement.plan].name,
      source: entitlement.source,
      companyName,
      teamCompanies,
      familyOrganizer: familyOrganizer
        ? familyOrganizer.fullName?.trim() ||
          familyOrganizer.username ||
          familyOrganizer.email ||
          null
        : null,
      limits: entitlement.limits,
      subscription: publicSubscription(
        entitlement.source === "own" ? entitlement.subscription : own,
      ),
      usage: {
        collections: ownCollections,
        // Files on their own items (company items count against the company).
        storageBytes: Number((await Attachment.sum("size", { where: { ownerUserId: userId, companyId: null } })) || 0),
      },
      trials: {
        premium:
          !usedTrials.some((trial) => trial.plan === "premium") &&
          !(entitlement.source === "own" && entitlement.plan !== "free"),
        family:
          !usedTrials.some((trial) => trial.plan === "family") &&
          entitlement.source !== "family" &&
          !(entitlement.source === "own" && entitlement.plan === "family"),
      },
      companies: companies.filter(Boolean),
      /** List prices in US cents per month, by billing period (yearly = 12 × this). */
      prices: PRICES,
    };
  }

  /**
   * Start a 14-day trial: no card, nothing charged. Premium or Family for the caller, or
   * Team for a company the caller owns. One trial per plan per person or company.
   */
  async startTrial(userId: number, plan: unknown, companyId?: unknown) {
    if (!TRIAL_PLANS.includes(plan as PlanId)) {
      throw new BillingError("That plan doesn't have a trial.");
    }
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY_MS);

    if (plan === "team") {
      const id = Number(companyId);
      const member = Number.isInteger(id)
        ? await CompanyMember.findOne({
            where: { companyId: id, userId, status: "active" },
          })
        : null;
      if (!member || member.role !== "owner") {
        throw new BillingError(
          "Only the company's owner can start a Team trial.",
          403,
        );
      }
      const current = await EntitlementService.forCompany(id);
      if (current)
        throw new BillingError("This company already has Team.", 409);
      return this.createTrial({ companyId: id }, "team", trialEndsAt);
    }

    const current = await EntitlementService.forUser(userId);
    if (
      current.source === "own" &&
      (current.plan === plan ||
        PLANS[current.plan].rank > PLANS[plan as PlanId].rank)
    ) {
      throw new BillingError(
        `You already have ${PLANS[current.plan].name}.`,
        409,
      );
    }
    if (
      plan === "family" &&
      (await FamilyMember.count({ where: { userId, status: "active" } }))
    ) {
      throw new BillingError(
        "You are in someone's family. Leave it to start your own.",
        409,
      );
    }
    return this.createTrial({ userId }, plan as PlanId, trialEndsAt);
  }

  async createTrial(
    owner: { userId: number } | { companyId: number },
    plan: PlanId,
    trialEndsAt: Date,
  ) {
    try {
      return await sequelize.transaction(async (transaction) => {
        await TrialUsed.create({ ...owner, plan }, { transaction });
        const subscription = await Subscription.create(
          { ...owner, plan, status: "trialing", trialEndsAt },
          { transaction },
        );
        return publicSubscription(subscription);
      });
    } catch (error) {
      // The unique index on trials_used: this trial was already used.
      if (error instanceof UniqueConstraintError) {
        throw new BillingError(
          "companyId" in owner
            ? "This company already used its Team trial."
            : `You already used your ${PLANS[plan].name} trial.`,
          409,
        );
      }
      throw error;
    }
  }
}

export default new BillingService();
