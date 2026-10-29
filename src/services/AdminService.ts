import { Op } from "sequelize";
import { DISCOUNT_PERCENT, PRICES, PlanId } from "../common/plans";
import Company from "../models/Company";
import DiscountRequest from "../models/DiscountRequest";
import Subscription from "../models/Subscription";
import User from "../models/User";
import { isLive } from "./EntitlementService";

const DAY_MS = 24 * 60 * 60 * 1000;
type PaidPlan = Exclude<PlanId, "free">;
const PAID: PaidPlan[] = ["premium", "family", "team"];

/**
 * The admin view: subscribers, trials, failed payments, revenue by plan, discount requests.
 * Revenue is estimated from list prices (before tax, after the nonprofit discount);
 * Stripe's dashboard has the exact figures.
 */
class AdminService {
  async overview(now = new Date()) {
    const rows = await Subscription.findAll({
      where: { status: { [Op.in]: ["trialing", "active", "past_due"] } },
    });
    const live = rows.filter((row) => isLive(row, now));

    const userIds = [...new Set(live.map((row) => row.userId).filter(Boolean))] as number[];
    const companyIds = [...new Set(live.map((row) => row.companyId).filter(Boolean))] as number[];
    const users = new Map(
      (await User.findAll({ where: { id: userIds }, attributes: ["id", "email"] })).map((user) => [user.id, user.email])
    );
    const companies = new Map(
      (await Company.findAll({ where: { id: companyIds }, attributes: ["id", "name", "discount"] })).map((company) => [
        company.id,
        company,
      ])
    );
    const ownerOf = (row: Subscription) =>
      row.companyId
        ? { kind: "company" as const, id: row.companyId, label: companies.get(row.companyId)?.name || `Company ${row.companyId}` }
        : { kind: "user" as const, id: row.userId as number, label: users.get(row.userId as number) || `User ${row.userId}` };

    const plans = Object.fromEntries(
      PAID.map((plan) => [plan, { subscribers: 0, monthly: 0, yearly: 0, seats: 0, cancelling: 0, mrrCents: 0, trials: 0 }])
    ) as Record<PaidPlan, { subscribers: number; monthly: number; yearly: number; seats: number; cancelling: number; mrrCents: number; trials: number }>;

    for (const row of live) {
      const plan = row.plan as PaidPlan;
      if (!plans[plan]) continue;
      if (!row.stripeSubscriptionId) {
        if (row.status === "trialing") plans[plan].trials += 1;
        continue;
      }
      const interval = row.interval === "year" ? "year" : "month";
      const seats = plan === "team" ? row.seats || 1 : 1;
      const discounted = row.companyId && companies.get(row.companyId)?.discount;
      const cents = PRICES[plan][interval] * seats * (discounted ? (100 - DISCOUNT_PERCENT) / 100 : 1);
      plans[plan].subscribers += 1;
      plans[plan][interval === "year" ? "yearly" : "monthly"] += 1;
      plans[plan].seats += seats;
      if (row.cancelAtPeriodEnd) plans[plan].cancelling += 1;
      plans[plan].mrrCents += Math.round(cents);
    }

    const trialsEndingSoon = live
      .filter(
        (row) =>
          !row.stripeSubscriptionId &&
          row.status === "trialing" &&
          row.trialEndsAt &&
          new Date(row.trialEndsAt).getTime() - now.getTime() <= 3 * DAY_MS
      )
      .map((row) => ({ id: row.id, plan: row.plan, owner: ownerOf(row), trialEndsAt: row.trialEndsAt }));

    const failedPayments = live
      .filter((row) => row.status === "past_due")
      .map((row) => ({ id: row.id, plan: row.plan, owner: ownerOf(row), graceEndsAt: row.graceEndsAt ?? null }));

    const pending = await DiscountRequest.findAll({ where: { status: "pending" }, order: [["createdAt", "ASC"]] });
    const requestCompanies = new Map(
      (await Company.findAll({ where: { id: pending.map((request) => request.companyId) }, attributes: ["id", "name"] })).map(
        (company) => [company.id, company.name]
      )
    );
    const requesters = new Map(
      (
        await User.findAll({
          where: { id: pending.map((request) => request.userId).filter(Boolean) as number[] },
          attributes: ["id", "email"],
        })
      ).map((user) => [user.id, user.email])
    );

    const discounted = await Company.findAll({
      where: { discount: { [Op.ne]: null } },
      attributes: ["id", "name", "discount"],
      order: [["name", "ASC"]],
    });
    const suspended = await Company.count({ where: { status: "suspended" } });
    const markedForRemoval = await Company.findAll({
      where: { markedForRemovalAt: { [Op.ne]: null } },
      attributes: ["id", "name", "suspendedAt", "markedForRemovalAt"],
      order: [["markedForRemovalAt", "ASC"]],
    });

    return {
      users: {
        total: await User.count(),
        last30Days: await User.count({ where: { createdAt: { [Op.gte]: new Date(now.getTime() - 30 * DAY_MS) } } }),
      },
      plans,
      mrrCents: PAID.reduce((sum, plan) => sum + plans[plan].mrrCents, 0),
      trialsEndingSoon,
      failedPayments,
      discounts: {
        percent: DISCOUNT_PERCENT,
        pending: pending.map((request) => ({
          id: request.id,
          companyId: request.companyId,
          companyName: requestCompanies.get(request.companyId) || `Company ${request.companyId}`,
          requestedBy: request.userId ? requesters.get(request.userId) || null : null,
          kind: request.kind,
          organization: request.organization,
          website: request.website ?? null,
          note: request.note ?? null,
          createdAt: request.createdAt,
        })),
        active: discounted.map((company) => ({ id: company.id, name: company.name, kind: company.discount })),
      },
      companies: {
        suspended,
        markedForRemoval: markedForRemoval.map((company) => ({
          id: company.id,
          name: company.name,
          suspendedAt: company.suspendedAt ?? null,
          markedForRemovalAt: company.markedForRemovalAt ?? null,
        })),
      },
    };
  }
}

export default new AdminService();
