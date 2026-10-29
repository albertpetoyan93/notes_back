/**
 * 2keevo plans, as published on the pricing page and in the subscription policy.
 * The single place that says what each plan allows; the server enforces it.
 *
 * Security features (encryption, sessions, 2FA, passkeys) are on every plan and are
 * never listed here.
 */

export type PlanId = "free" | "premium" | "family" | "team";

export interface PlanLimits {
  /** Personal collections a person can own. Null = no limit. */
  collections: number | null;
  /** People one note or collection can be shared with. Null = no limit. */
  sharePeople: number | null;
  /** Shares that end on a date. */
  shareExpiry: boolean;
  /** Weak, reused and old password report. */
  passwordHealth: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Higher wins when someone is covered by more than one plan. */
  rank: number;
  limits: PlanLimits;
}

const UNLIMITED: PlanLimits = {
  collections: null,
  sharePeople: null,
  shareExpiry: true,
  passwordHealth: true,
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    rank: 0,
    limits: { collections: 2, sharePeople: 3, shareExpiry: false, passwordHealth: false },
  },
  premium: { id: "premium", name: "Premium", rank: 1, limits: UNLIMITED },
  // Team gives every member Premium; it ranks with Premium for the personal vault.
  team: { id: "team", name: "Team", rank: 1, limits: UNLIMITED },
  family: { id: "family", name: "Family", rank: 2, limits: UNLIMITED },
};

export const TRIAL_DAYS = 14;
export const TRIAL_REMINDER_DAYS = 3;
export const TEAM_MIN_SEATS = 2;

/** Plans a trial can be started for. */
export const TRIAL_PLANS: PlanId[] = ["premium", "family", "team"];

/** People an organizer can invite into Family (6 with the organizer). */
export const FAMILY_MAX_MEMBERS = 5;

/** Failed payment: days of grace before a personal plan ends or a company is suspended. */
export const GRACE_DAYS = 14;

/** Yearly plans: the renewal email goes out this many days ahead. */
export const RENEWAL_REMINDER_DAYS = 7;

/** A suspended company: warnings on these days, then marked for removal. */
export const REMOVAL_WARNING_DAYS = [60, 83];
export const REMOVAL_DAYS = 90;

/**
 * List prices in US cents per month, before tax: monthly billing, or yearly billing
 * (charged as 12 months at this rate). Stripe holds the real prices; these set them up
 * (`npm run stripe:setup`) and estimate revenue for the admin view.
 */
export const PRICES: Record<Exclude<PlanId, "free">, { month: number; year: number }> = {
  premium: { month: 349, year: 250 },
  family: { month: 599, year: 450 },
  team: { month: 500, year: 400 },
};

/** Nonprofits and schools: this much off Team, for as long as they stay on it. */
export const DISCOUNT_PERCENT = 50;

/** The cheapest plan that removes a limit, for "upgrade to …" messages. */
export const UNLOCKED_BY: PlanId = "premium";
