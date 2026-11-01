import type AdminAction from "../models/AdminAction";
import type { StaffRole } from "../models/AdminStaff";
import type { CompanyPolicies } from "../models/Company";
import { Permission, permissionsFor } from "./permissions";

export interface AdminActionRow {
  id: number;
  at: string;
  staffEmail: string;
  role: StaffRole | null;
  action: string;
  targetUserId: number | null;
  targetEmail: string | null;
  targetCompanyId: number | null;
  reason: string | null;
  details: Record<string, unknown>;
}

// Narrow input so plain rows (`get({ plain: true })`) work as well as models.
export type AdminActionInput = Pick<
  AdminAction,
  "id" | "createdAt" | "staffEmail" | "role" | "action" | "targetUserId" | "targetEmail" | "targetCompanyId" | "reason" | "details"
>;

export function toAdminActionRow(a: AdminActionInput): AdminActionRow {
  return {
    id: a.id,
    at: a.createdAt.toISOString(),
    staffEmail: a.staffEmail,
    role: a.role ?? null,
    action: a.action,
    targetUserId: a.targetUserId ?? null,
    targetEmail: a.targetEmail ?? null,
    targetCompanyId: a.targetCompanyId ?? null,
    reason: a.reason ?? null,
    details: a.details,
  };
}

export interface StaffMe {
  userId: number;
  email: string;
  name: string;
  role: StaffRole;
  permissions: Permission[];
}

export function toStaffMe(
  user: { id: number; email: string; username: string; fullName?: string | null },
  role: StaffRole
): StaffMe {
  return {
    userId: user.id,
    email: user.email,
    name: user.fullName || user.username,
    role,
    permissions: permissionsFor(role),
  };
}

// Everything below lists only the columns it reads, so a secret column can't
// leak by being copied along. Dates go out as ISO strings.
type DateLike = Date | string | null | undefined;

function iso(value: DateLike): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export type Browser = "Chrome" | "Edge" | "Firefox" | "Safari" | "Other";
export type OsName = "Windows" | "macOS" | "Linux" | "Android" | "iOS" | "Other";

/** Just enough to tell sessions apart in a list; not a full parser. */
export function parseUserAgent(userAgent?: string | null): { browser: Browser; os: OsName } {
  const ua = userAgent || "";
  // Edge and Firefox-on-iOS also say "Chrome"/"Safari", so check them first.
  const browser: Browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Other";
  // iPhone/iPad say "like Mac OS X" and Android says "Linux", so those go first.
  const os: OsName = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux|X11/.test(ua)
            ? "Linux"
            : "Other";
  return { browser, os };
}

export interface UserRow {
  id: number;
  email: string;
  name: string;
  createdAt: string | null;
  plan: string;
  e2e: boolean;
  twoFactor: boolean;
  lastActive: string | null;
  status: "active" | "suspended";
}

type UserBasics = {
  id: number;
  email: string;
  username: string;
  fullName?: string | null;
  createdAt: DateLike;
  suspendedAt?: DateLike;
};

export function toUserRow(
  u: UserBasics & { e2eEnabled: boolean; twoFactorEnabled: boolean },
  extra: { plan: string; lastActive: string | null }
): UserRow {
  return {
    id: u.id,
    email: u.email,
    name: u.fullName || u.username,
    createdAt: iso(u.createdAt),
    plan: extra.plan,
    e2e: !!u.e2eEnabled,
    twoFactor: !!u.twoFactorEnabled,
    lastActive: extra.lastActive,
    status: u.suspendedAt ? "suspended" : "active",
  };
}

export interface SessionRow {
  id: number;
  kind: string;
  browser: Browser;
  os: OsName;
  ip: string | null;
  createdAt: string | null;
  lastActiveAt: string | null;
  locked: boolean;
  extensionVersion: string | null;
}

export function toSessionRow(s: {
  id: number;
  kind: string;
  userAgent?: string | null;
  ip?: string | null;
  createdAt: DateLike;
  lastUsedAt?: DateLike;
  lastActiveAt?: DateLike;
  lockedAt?: DateLike;
  extensionVersion?: string | null;
}): SessionRow {
  const { browser, os } = parseUserAgent(s.userAgent);
  return {
    id: s.id,
    kind: s.kind,
    browser,
    os,
    ip: s.ip ?? null,
    createdAt: iso(s.createdAt),
    // lastActiveAt is only kept for web sessions; others only have lastUsedAt.
    lastActiveAt: iso(s.lastActiveAt ?? s.lastUsedAt),
    locked: !!s.lockedAt,
    extensionVersion: s.extensionVersion ?? null,
  };
}

export interface SubscriptionRow {
  id: number;
  plan: string;
  interval: string | null;
  status: string;
  seats: number | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: string | null;
  stripeManaged: boolean;
}

export type SubscriptionInput = {
  id: number;
  plan: string;
  interval?: string | null;
  status: string;
  seats?: number | null;
  trialEndsAt?: DateLike;
  currentPeriodEnd?: DateLike;
  cancelAtPeriodEnd: boolean;
  graceEndsAt?: DateLike;
  /** Only whether it is set is read, never the id. */
  stripeSubscriptionId?: string | null;
};

export function toSubscriptionRow(s: SubscriptionInput): SubscriptionRow {
  return {
    id: s.id,
    plan: s.plan,
    interval: s.interval ?? null,
    status: s.status,
    seats: s.seats ?? null,
    trialEndsAt: iso(s.trialEndsAt),
    currentPeriodEnd: iso(s.currentPeriodEnd),
    cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
    graceEndsAt: iso(s.graceEndsAt),
    stripeManaged: !!s.stripeSubscriptionId,
  };
}

export interface ActivityRow {
  action: string;
  at: string | null;
}

/** Only what happened and when: never details, item or collection ids, IP or browser. */
export function toActivityRow(e: { action: string; createdAt: DateLike }): ActivityRow {
  return { action: e.action, at: iso(e.createdAt) };
}

// The password-reset link is valid for an hour (AuthService.forgotPassword).
const RESET_LINK_MS = 60 * 60 * 1000;

export interface UserDetail {
  account: {
    id: number;
    email: string;
    name: string;
    createdAt: string | null;
    status: "active" | "suspended";
    suspendedAt: string | null;
  };
  security: {
    e2e: boolean;
    twoFactor: boolean;
    recoveryCodesLeft: number;
    passkeys: { name: string; lastUsedAt: string | null; createdAt: string | null }[];
    recoveryKey: boolean;
    emergencyContacts: number;
    mustChangeMasterPassword: boolean;
    lastPasswordResetRequestAt: string | null;
  };
  sessions: SessionRow[];
  usage: {
    itemsByCategory: Record<string, number>;
    collections: number;
    sharesSent: number;
    sharesReceived: number;
    attachmentBytes: number;
    lastItemChangeAt: string | null;
  };
  subscriptions: SubscriptionRow[];
  companies: { id: number; name: string; role: string }[];
  activity: ActivityRow[];
  staffActions: AdminActionRow[];
  supportRequests: {
    id: number;
    kind: string;
    status: string;
    createdAt: string | null;
    expiresAt: string | null;
  }[];
}

/** One field per section of the user page; each is built by its own query. */
export interface UserDetailParts {
  user: UserBasics & {
    e2eEnabled: boolean;
    twoFactorEnabled: boolean;
    mustChangeMasterPassword?: boolean;
    passwordResetExpires?: DateLike;
    /** Only the length is read, never the codes. */
    twoFactorRecoveryCodes?: unknown[] | null;
    /** Only whether it is set is read, never the value. */
    recoveryProtectedUserKey?: string | null;
  };
  passkeys: { name: string; lastUsedAt?: DateLike; createdAt: DateLike }[];
  emergencyContacts: number;
  sessions: Parameters<typeof toSessionRow>[0][];
  usage: {
    itemsByCategory: Record<string, number>;
    collections: number;
    sharesSent: number;
    sharesReceived: number;
    attachmentBytes: number;
    lastItemChangeAt?: DateLike;
  };
  subscriptions: SubscriptionInput[];
  companies: { id: number; name: string; role: string }[];
  activity: Parameters<typeof toActivityRow>[0][];
  staffActions: AdminActionInput[];
  supportRequests: {
    id: number;
    kind: string;
    status: string;
    createdAt: DateLike;
    expiresAt: DateLike;
  }[];
}

export function toUserDetail(parts: UserDetailParts): UserDetail {
  const { user, usage } = parts;
  const resetExpires = user.passwordResetExpires
    ? new Date(user.passwordResetExpires).getTime()
    : null;
  return {
    account: {
      id: user.id,
      email: user.email,
      name: user.fullName || user.username,
      createdAt: iso(user.createdAt),
      status: user.suspendedAt ? "suspended" : "active",
      suspendedAt: iso(user.suspendedAt),
    },
    security: {
      e2e: !!user.e2eEnabled,
      twoFactor: !!user.twoFactorEnabled,
      recoveryCodesLeft: user.twoFactorRecoveryCodes?.length ?? 0,
      passkeys: parts.passkeys.map((p) => ({
        name: p.name,
        lastUsedAt: iso(p.lastUsedAt),
        createdAt: iso(p.createdAt),
      })),
      recoveryKey: !!user.recoveryProtectedUserKey,
      emergencyContacts: parts.emergencyContacts,
      mustChangeMasterPassword: !!user.mustChangeMasterPassword,
      // Only the expiry is stored; the request was made one link-lifetime before it.
      lastPasswordResetRequestAt: resetExpires === null ? null : iso(new Date(resetExpires - RESET_LINK_MS)),
    },
    sessions: parts.sessions.map(toSessionRow),
    usage: {
      itemsByCategory: { ...usage.itemsByCategory },
      collections: usage.collections,
      sharesSent: usage.sharesSent,
      sharesReceived: usage.sharesReceived,
      attachmentBytes: usage.attachmentBytes,
      lastItemChangeAt: iso(usage.lastItemChangeAt),
    },
    subscriptions: parts.subscriptions.map(toSubscriptionRow),
    companies: parts.companies.map((c) => ({ id: c.id, name: c.name, role: c.role })),
    activity: parts.activity.map(toActivityRow),
    staffActions: parts.staffActions.map(toAdminActionRow),
    supportRequests: parts.supportRequests.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      createdAt: iso(r.createdAt),
      expiresAt: iso(r.expiresAt),
    })),
  };
}

export interface CompanyRow {
  id: number;
  name: string;
  status: string;
  suspendedAt: string | null;
  markedForRemovalAt: string | null;
  discount: string | null;
  createdAt: string | null;
  owner: { userId: number; email: string } | null;
  seatsUsed: number;
  subscription: SubscriptionRow | null;
}

type CompanyBasics = {
  id: number;
  name: string;
  status: string;
  suspendedAt?: DateLike;
  markedForRemovalAt?: DateLike;
  discount?: string | null;
  createdAt: DateLike;
};

type CompanyExtra = {
  owner: { userId: number; email: string } | null;
  seatsUsed: number;
  subscription: SubscriptionInput | null;
};

function companyRowOf(c: CompanyBasics, extra: CompanyExtra): CompanyRow {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    suspendedAt: iso(c.suspendedAt),
    markedForRemovalAt: iso(c.markedForRemovalAt),
    discount: c.discount ?? null,
    createdAt: iso(c.createdAt),
    owner: extra.owner ? { userId: extra.owner.userId, email: extra.owner.email } : null,
    seatsUsed: extra.seatsUsed,
    subscription: extra.subscription ? toSubscriptionRow(extra.subscription) : null,
  };
}

export function toCompanyRow(c: CompanyBasics, extra: CompanyExtra): CompanyRow {
  return companyRowOf(c, extra);
}

export interface CompanyDetail extends CompanyRow {
  members: {
    userId: number | null;
    email: string;
    role: string;
    status: string;
    joinedAt: string | null;
    twoFactor: boolean;
  }[];
  groups: { id: number; name: string; members: number }[];
  policies: {
    require2fa: boolean;
    minPasswordLength: number | null;
    maxSessionDays: number | null;
    maxIdleMinutes: number | null;
  };
  recovery: boolean;
}

export function toCompanyDetail(parts: {
  company: CompanyBasics & {
    policies?: CompanyPolicies | null;
    /** Only whether it is set is read, never the key. */
    recoveryPublicKey?: string | null;
  };
  owner: CompanyExtra["owner"];
  seatsUsed: number;
  subscription: CompanyExtra["subscription"];
  members: {
    userId?: number | null;
    email: string;
    role: string;
    status: string;
    createdAt: DateLike;
    twoFactorEnabled?: boolean | null;
  }[];
  groups: { id: number; name: string; members: number }[];
}): CompanyDetail {
  const { company } = parts;
  const policies = company.policies || {};
  return {
    ...companyRowOf(company, parts),
    members: parts.members.map((m) => ({
      userId: m.userId ?? null,
      email: m.email,
      role: m.role,
      status: m.status,
      joinedAt: iso(m.createdAt),
      twoFactor: !!m.twoFactorEnabled,
    })),
    groups: parts.groups.map((g) => ({ id: g.id, name: g.name, members: g.members })),
    policies: {
      require2fa: !!policies.require2fa,
      minPasswordLength: policies.minPasswordLength ?? null,
      maxSessionDays: policies.maxSessionDays ?? null,
      maxIdleMinutes: policies.maxIdleMinutes ?? null,
    },
    recovery: !!company.recoveryPublicKey,
  };
}
