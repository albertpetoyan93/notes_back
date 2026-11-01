import { NextFunction, Response } from "express";
import { redactAnalytics, redactOverview, smallCount } from "@src/admin/redact";
import AnalyticsService from "@src/services/admin/AnalyticsService";
import { utcDate } from "@src/services/ActivityService";
import type { AdminActionName } from "@src/services/admin/AdminActionService";
import AdminActionService, { cleanReason } from "@src/services/admin/AdminActionService";
import AdminBillingService from "@src/services/admin/AdminBillingService";
import AdminCompaniesService from "@src/services/admin/AdminCompaniesService";
import AdminUsersService from "@src/services/admin/AdminUsersService";
import StaffService from "@src/services/admin/StaffService";
import SupportActionService from "@src/services/admin/SupportActionService";
import SupportRequestService from "@src/services/admin/SupportRequestService";
import AdminService from "@src/services/AdminService";
import SignupSourceService, { GROUP_BY, GroupBy, SourceReport } from "@src/services/SignupSourceService";
import type { StaffRole } from "@src/models/AdminStaff";
import type { StaffRequest } from "@src/types";

const INT4_MAX = 2147483647;
const STAFF_ROLES: StaffRole[] = ["admin", "support", "marketing"];
const PLANS = new Set(["free", "premium", "family", "team"]);

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** AdminAction rows store staff without the session id. */
const staffOf = (req: StaffRequest) => {
  const s = req.staff!;
  return { userId: s.userId, email: s.email, role: s.role };
};

function isServiceError(e: unknown): e is { status: number; message: string; code?: string } {
  return !!e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number";
}

function isStripeError(e: unknown): e is { type: string; message?: string } {
  return !!e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string"
    && String((e as { type: string }).type).startsWith("Stripe");
}

/** Map known service / Stripe errors; unknown ones go to the global handler. */
async function run(res: Response, next: NextFunction, work: () => Promise<unknown>) {
  try {
    const body = await work();
    if (body === undefined) res.status(200).json({});
    else res.status(200).json(body);
  } catch (e) {
    if (isServiceError(e)) {
      const out: { message: string; code?: string } = { message: e.message };
      if (e.code) out.code = e.code;
      res.status(e.status).json(out);
      return;
    }
    if (isStripeError(e)) {
      res.status(502).json({ message: e.message || "Stripe request failed" });
      return;
    }
    next(e);
  }
}

/** Positive Postgres int4 id from a path param. */
function parseId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw fail(400, "Invalid id.");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > INT4_MAX) throw fail(400, "Invalid id.");
  return n;
}

function oneString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw fail(400, `Invalid ${label}.`);
  if (typeof value !== "string") throw fail(400, `Invalid ${label}.`);
  return value;
}

function optionalBool(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  const s = oneString(value, label);
  if (s === "true") return true;
  if (s === "false") return false;
  throw fail(400, `Invalid ${label}.`);
}

function optionalInt(value: unknown, label: string, min = 1): number | undefined {
  if (value === undefined) return undefined;
  const s = oneString(value, label);
  if (s === undefined || !/^\d+$/.test(s)) throw fail(400, `Invalid ${label}.`);
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > INT4_MAX) throw fail(400, `Invalid ${label}.`);
  return n;
}

function optionalIsoDate(value: unknown, label: string): Date | undefined {
  if (value === undefined) return undefined;
  const s = oneString(value, label);
  if (!s) throw fail(400, `Invalid ${label}.`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw fail(400, `Invalid ${label}.`);
  return d;
}

function parseStaffRole(value: unknown): StaffRole {
  if (typeof value !== "string" || !STAFF_ROLES.includes(value as StaffRole)) {
    throw fail(400, "Choose admin, support or marketing.");
  }
  return value as StaffRole;
}

/** Marketing sees totals only: every count under 5 becomes "<5". */
function redactSources(report: SourceReport) {
  const counts = (o: { signups: number; activated: number; paying: number }) => ({
    signups: smallCount(o.signups),
    activated: smallCount(o.activated),
    paying: smallCount(o.paying),
  });
  return {
    rows: report.rows.map((r) => ({ key: r.key, ...counts(r) })),
    totals: counts(report.totals),
    untagged: smallCount(report.untagged),
  };
}

export default class AdminController {
  static overview = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => redactOverview(await AdminService.overview(), req.staff!.role));
  };

  static analyticsDaily = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const today = utcDate(new Date());
      const from = oneString(req.query.from, "from") || today;
      const to = oneString(req.query.to, "to") || today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw fail(400, "from and to must be YYYY-MM-DD.");
      }
      if (from > to) throw fail(400, "from must be on or before to.");
      return redactAnalytics(await AnalyticsService.daily(from, to), req.staff!.role);
    });
  };

  static analyticsFunnel = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const today = utcDate(new Date());
      const from = oneString(req.query.from, "from") || today;
      const to = oneString(req.query.to, "to") || today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw fail(400, "from and to must be YYYY-MM-DD.");
      }
      if (from > to) throw fail(400, "from must be on or before to.");
      return redactAnalytics(await AnalyticsService.funnel(from, to), req.staff!.role);
    });
  };

  static analyticsRetention = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const weeks = optionalInt(req.query.weeks, "weeks", 1) ?? 12;
      if (weeks > 52) throw fail(400, "weeks must be at most 52.");
      return redactAnalytics(await AnalyticsService.retention(weeks), req.staff!.role);
    });
  };

  static analyticsExtensionVersions = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () =>
      redactAnalytics(await AnalyticsService.extensionVersions(), req.staff!.role)
    );
  };

  static marketingSignups = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const today = utcDate(new Date());
      const from = oneString(req.query.from, "from") || today;
      const to = oneString(req.query.to, "to") || today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw fail(400, "from and to must be YYYY-MM-DD.");
      }
      if (from > to) throw fail(400, "from must be on or before to.");
      const groupBy = oneString(req.query.groupBy, "groupBy") || "source";
      if (!(GROUP_BY as readonly string[]).includes(groupBy)) {
        throw fail(400, `groupBy must be one of ${GROUP_BY.join(", ")}.`);
      }
      const report = await SignupSourceService.bySource(from, to, groupBy as GroupBy);
      return req.staff!.role === "marketing" ? redactSources(report) : report;
    });
  };

  static listUsers = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const q = req.query;
      const filter: Parameters<typeof AdminUsersService.list>[0] = {};
      const rawQ = oneString(q.q, "q");
      if (rawQ !== undefined) filter.q = rawQ;
      const plan = oneString(q.plan, "plan");
      if (plan !== undefined) {
        if (!PLANS.has(plan)) throw fail(400, "Invalid plan.");
        filter.plan = plan;
      }
      const e2e = optionalBool(q.e2e, "e2e");
      if (e2e !== undefined) filter.e2e = e2e;
      const twoFactor = optionalBool(q.twoFactor, "twoFactor");
      if (twoFactor !== undefined) filter.twoFactor = twoFactor;
      const status = oneString(q.status, "status");
      if (status !== undefined) {
        if (status !== "active" && status !== "suspended") throw fail(400, "Invalid status.");
        filter.status = status;
      }
      const signedUpFrom = oneString(q.signedUpFrom, "signedUpFrom");
      if (signedUpFrom !== undefined) filter.signedUpFrom = signedUpFrom;
      const signedUpTo = oneString(q.signedUpTo, "signedUpTo");
      if (signedUpTo !== undefined) filter.signedUpTo = signedUpTo;
      const inactiveDays = optionalInt(q.inactiveDays, "inactiveDays", 0);
      if (inactiveDays !== undefined) filter.inactiveDays = inactiveDays;
      const page = optionalInt(q.page, "page");
      if (page !== undefined) filter.page = page;
      return AdminUsersService.list(filter);
    });
  };

  static getUser = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const id = parseId(req.params.id);
      const detail = await AdminUsersService.detail(id);
      if (!detail) throw fail(404, "User not found.");
      await AdminActionService.recordView({
        staff: staffOf(req),
        action: "viewed_user",
        targetUserId: id,
        req,
      });
      return detail;
    });
  };

  static passwordReset = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await SupportActionService.sendPasswordReset(req.staff!, parseId(req.params.id), req.body?.reason, req);
      return {};
    });
  };

  static signOutAll = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await SupportActionService.signOutAll(req.staff!, parseId(req.params.id), req.body?.reason, req);
      return {};
    });
  };

  static suspend = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await SupportActionService.suspend(
        req.staff!,
        parseId(req.params.id),
        req.body?.reason,
        req.body?.confirmEmail,
        req
      );
      return {};
    });
  };

  static unsuspend = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await SupportActionService.unsuspend(req.staff!, parseId(req.params.id), req.body?.reason, req);
      return {};
    });
  };

  static requestTwoFactorRemoval = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const result = await SupportRequestService.requestTwoFactorRemoval(
        req.staff!,
        parseId(req.params.id),
        req.body?.reason,
        req.body?.confirmEmail,
        req
      );
      return { id: result.id, expiresAt: new Date(result.expiresAt).toISOString() };
    });
  };

  static cancelSupportRequest = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await SupportRequestService.cancel(req.staff!, parseId(req.params.id), req.body?.reason, req);
      return {};
    });
  };

  static listCompanies = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const filter: Parameters<typeof AdminCompaniesService.list>[0] = {};
      const rawQ = oneString(req.query.q, "q");
      if (rawQ !== undefined) filter.q = rawQ;
      const page = optionalInt(req.query.page, "page");
      if (page !== undefined) filter.page = page;
      return AdminCompaniesService.list(filter);
    });
  };

  static getCompany = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const id = parseId(req.params.id);
      const detail = await AdminCompaniesService.detail(id);
      if (!detail) throw fail(404, "Company not found.");
      await AdminActionService.recordView({
        staff: staffOf(req),
        action: "viewed_company",
        targetCompanyId: id,
        req,
      });
      return detail;
    });
  };

  static transferOwnership = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const newOwnerUserId = req.body?.newOwnerUserId;
      if (typeof newOwnerUserId !== "number" || !Number.isInteger(newOwnerUserId) || newOwnerUserId < 1) {
        throw fail(400, "Choose the new owner.");
      }
      await SupportActionService.transferCompanyOwnership(
        req.staff!,
        parseId(req.params.id),
        newOwnerUserId,
        req.body?.reason,
        req
      );
      return {};
    });
  };

  static cancelSubscription = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await AdminBillingService.cancel(req.staff!, parseId(req.params.id), req.body?.reason, req);
      return {};
    });
  };

  static listPayments = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => AdminBillingService.payments(parseId(req.params.id)));
  };

  static refund = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const paymentIntentId = req.body?.paymentIntentId;
      if (typeof paymentIntentId !== "string" || !paymentIntentId.trim()) {
        throw fail(400, "Choose a payment.");
      }
      const amountCents = req.body?.amountCents;
      await AdminBillingService.refund(
        req.staff!,
        parseId(req.params.id),
        paymentIntentId,
        amountCents === undefined || amountCents === null ? undefined : amountCents,
        req.body?.reason,
        req
      );
      return {};
    });
  };

  static changePlan = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await AdminBillingService.changePlan(
        req.staff!,
        parseId(req.params.id),
        { plan: req.body?.plan, interval: req.body?.interval },
        req.body?.reason,
        req
      );
      return {};
    });
  };

  static extendTrial = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await AdminBillingService.extendTrial(req.staff!, parseId(req.params.id), req.body?.days, req.body?.reason, req);
      return {};
    });
  };

  static approveDiscount = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await AdminBillingService.decideDiscount(req.staff!, parseId(req.params.id), true, req.body?.reason, req);
      return {};
    });
  };

  static declineDiscount = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await AdminBillingService.decideDiscount(req.staff!, parseId(req.params.id), false, req.body?.reason, req);
      return {};
    });
  };

  static removeDiscount = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      await AdminBillingService.removeDiscount(req.staff!, parseId(req.params.id), req.body?.reason, req);
      return {};
    });
  };

  static listStaff = async (_req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => StaffService.list());
  };

  static addStaff = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const why = cleanReason(req.body?.reason);
      const email = req.body?.email;
      if (typeof email !== "string" || !email.trim()) throw fail(400, "Enter an email.");
      const role = parseStaffRole(req.body?.role);
      const row = await StaffService.add(email, role, req.staff!.userId);
      await AdminActionService.record({
        staff: staffOf(req),
        action: "staff_added",
        targetUserId: row.userId,
        reason: why,
        details: { role },
        req,
      });
      return row;
    });
  };

  static updateStaff = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const why = cleanReason(req.body?.reason);
      const userId = parseId(req.params.userId);
      const change: { role?: StaffRole; disabled?: boolean } = {};
      if (req.body?.role !== undefined) change.role = parseStaffRole(req.body.role);
      if (req.body?.disabled !== undefined) {
        if (typeof req.body.disabled !== "boolean") throw fail(400, "Invalid disabled.");
        change.disabled = req.body.disabled;
      }
      if (change.role === undefined && change.disabled === undefined) {
        throw fail(400, "Choose a role or disable.");
      }
      const row = await StaffService.update(userId, change, req.staff!.userId);
      await AdminActionService.record({
        staff: staffOf(req),
        action: "staff_changed",
        targetUserId: userId,
        reason: why,
        details: change.role !== undefined ? { role: change.role } : { disabled: change.disabled as boolean },
        req,
      });
      return row;
    });
  };

  static listActions = async (req: StaffRequest, res: Response, next: NextFunction) => {
    await run(res, next, async () => {
      const q = req.query;
      const filter: Parameters<typeof AdminActionService.list>[0] = {};
      const staffUserId = optionalInt(q.staffUserId, "staffUserId");
      if (staffUserId !== undefined) filter.staffUserId = staffUserId;
      const action = oneString(q.action, "action");
      if (action !== undefined) filter.action = action as AdminActionName;
      const targetUserId = optionalInt(q.targetUserId, "targetUserId");
      if (targetUserId !== undefined) filter.targetUserId = targetUserId;
      const targetCompanyId = optionalInt(q.targetCompanyId, "targetCompanyId");
      if (targetCompanyId !== undefined) filter.targetCompanyId = targetCompanyId;
      const from = optionalIsoDate(q.from, "from");
      if (from !== undefined) filter.from = from;
      const to = optionalIsoDate(q.to, "to");
      if (to !== undefined) filter.to = to;
      const page = optionalInt(q.page, "page");
      if (page !== undefined) filter.page = page;
      return AdminActionService.list(filter);
    });
  };
}
