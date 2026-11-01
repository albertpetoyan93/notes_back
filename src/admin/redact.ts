import type { StaffRole } from "../models/AdminStaff";
import type AdminService from "../services/AdminService";
import { can } from "./permissions";

export type AdminOverview = Awaited<ReturnType<typeof AdminService.overview>>;

/** Small counts could single out a person, so marketing sees "<5" instead of 1..4. */
export function smallCount(n: number): number | "<5" {
  return n >= 1 && n <= 4 ? "<5" : n;
}

function mapValues<T extends Record<string, number>>(o: T): Record<keyof T, number | "<5"> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, smallCount(v)])) as Record<keyof T, number | "<5">;
}

/** What a role may see of the overview. Returns a new object; the input is not changed. */
export function redactOverview(o: AdminOverview, role: StaffRole): any {
  const out: any = { ...o };
  if (!can(role, "overview.revenue")) {
    delete out.plans;
    delete out.mrrCents;
    delete out.failedPayments;
    delete out.discounts;
  }
  if (role !== "marketing") return out;

  delete out.suspendedAccounts;
  // Trial rows name the owner.
  delete out.trialsEndingSoon;
  out.users = mapValues(o.users);
  // The company list names companies, so only the count stays (the UI expects an array).
  out.companies = { suspended: smallCount(o.companies.suspended), markedForRemoval: [] };
  out.activity = {
    ...o.activity,
    signups: mapValues(o.activity.signups),
    activeUsers: mapValues(o.activity.activeUsers),
    // Today's entry would undo the small-count rule on the headline numbers.
    daily: o.activity.daily.map((d) => ({ ...d, signups: smallCount(d.signups), active: smallCount(d.active) })),
  };
  return out;
}

function redactCounts<T extends Record<string, unknown>>(row: T, keys: (keyof T)[]): T {
  const out = { ...row };
  for (const key of keys) {
    const value = out[key];
    if (typeof value === "number") (out as any)[key] = smallCount(value);
  }
  return out;
}

/** Marketing sees "<5" on every small count in analytics payloads. */
export function redactAnalytics(payload: any, role: StaffRole): any {
  if (role !== "marketing") return payload;
  if (Array.isArray(payload)) {
    return payload.map((row) =>
      redactCounts(row, [
        "signups",
        "dau",
        "wau",
        "mau",
        "paying",
        "trials",
        "churned",
        "activatedFirstItem",
        "activatedExtension",
        "activatedAutofill",
        "signedUp",
        "firstItem",
        "extension",
        "autofill",
        "activeDay7",
        "activeDay30",
        "sessions",
        "cohortSize",
        "active",
      ])
    );
  }
  if (payload?.days && payload?.totals) {
    return {
      ...payload,
      days: redactAnalytics(payload.days, role),
      totals: redactCounts(payload.totals, [
        "signedUp",
        "firstItem",
        "extension",
        "autofill",
        "activeDay7",
        "activeDay30",
        "paying",
      ]),
    };
  }
  if (payload?.rows) {
    return {
      ...payload,
      rows: payload.rows.map((row: any) => ({
        ...row,
        cohortSize: smallCount(row.cohortSize),
        weeks: (row.weeks || []).map((cell: any) => ({
          ...cell,
          cohortSize: smallCount(cell.cohortSize),
          active: smallCount(cell.active),
        })),
      })),
    };
  }
  return payload;
}
