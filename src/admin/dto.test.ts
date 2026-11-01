import { describe, expect, it } from "vitest";
import { USER_ACTIVITY_ACTIONS } from "../services/AuditService";
import {
  parseUserAgent,
  toActivityRow,
  toCompanyDetail,
  toCompanyRow,
  toSessionRow,
  toSubscriptionRow,
  toUserDetail,
  toUserRow,
  UserDetailParts,
} from "./dto";

const S = "SECRET";
const created = new Date("2026-01-02T03:04:05.000Z");
const later = new Date("2026-02-03T04:05:06.000Z");

// Every forbidden column, so a DTO that copies a row wholesale fails.
const user = {
  id: 1,
  email: "a@example.com",
  username: "alice",
  fullName: "Alice A",
  createdAt: created,
  e2eEnabled: true,
  twoFactorEnabled: true,
  suspendedAt: null,
  mustChangeMasterPassword: false,
  passwordResetExpires: new Date("2026-02-03T05:00:00.000Z"),
  recoveryProtectedUserKey: S,
  twoFactorRecoveryCodes: [S, S, S],
  password: S,
  twoFactorSecret: S,
  passwordResetTokenHash: S,
  kdfSalt: S,
  kdfParams: S,
  protectedUserKey: S,
  protectedPrivateKey: S,
  recoveryAuthHash: S,
  publicKey: S,
};

const session = {
  id: 5,
  userId: 1,
  kind: "web",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  ip: "203.0.113.9",
  createdAt: created,
  lastUsedAt: later,
  lastActiveAt: later,
  lockedAt: null,
  expiresAt: later,
  tokenHash: S,
  previousTokenHash: S,
};

const subscription = {
  id: 7,
  userId: 1,
  companyId: null,
  plan: "premium",
  interval: "year",
  status: "active",
  seats: null,
  trialEndsAt: null,
  currentPeriodEnd: later,
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  stripeCustomerId: S,
  stripeSubscriptionId: S,
};

const auditEvent = {
  id: 9,
  action: "login",
  createdAt: later,
  details: { title: S },
  noteId: 123456,
  collectionId: 654321,
  ip: S,
  userAgent: S,
  actorId: 1,
};

const adminAction = {
  id: 3,
  createdAt: later,
  staffEmail: "staff@example.com",
  role: "support" as const,
  action: "viewed_user",
  targetUserId: 1,
  targetEmail: "a@example.com",
  targetCompanyId: null,
  reason: "ticket 4",
  details: {},
};

const company = {
  id: 20,
  name: "Acme",
  status: "active" as const,
  suspendedAt: null,
  markedForRemovalAt: null,
  discount: "school" as const,
  createdAt: created,
  policies: { require2fa: true, minPasswordLength: 12, maxSessionDays: null, maxIdleMinutes: 30, secretPolicy: S },
  recoveryPublicKey: S,
  recoveryKeyVersion: 2,
};

const member = {
  userId: 1,
  email: "a@example.com",
  role: "owner" as const,
  status: "active" as const,
  createdAt: created,
  twoFactorEnabled: true,
  password: S,
  publicKey: S,
};

const passkey = { name: "Laptop", lastUsedAt: later, createdAt: created, publicKey: S, credentialId: S, prfUserKey: S };
const membership = { id: 20, name: "Acme", role: "owner", policies: S };
const supportRequest = { id: 1, kind: "remove_2fa", status: "pending", createdAt: created, expiresAt: later, tokenHash: S, reason: S };
const owner = { userId: 1, email: "a@example.com", password: S };
const companySub = { ...subscription, companyId: 20 };
const group = { id: 4, name: "Ops", members: 2, collectionId: S };

describe("admin dto allow-lists", () => {
  it("toUserRow", () => {
    const out = toUserRow(user, { plan: "premium", lastActive: later.toISOString() });
    expect(Object.keys(out).sort()).toEqual([
      "createdAt", "e2e", "email", "id", "lastActive", "name", "plan", "status", "twoFactor",
    ]);
    expect(out).toMatchObject({ name: "Alice A", e2e: true, twoFactor: true, status: "active", createdAt: created.toISOString() });
    expect(JSON.stringify(out)).not.toContain(S);
  });

  it("toUserRow: suspended, and name falls back to username", () => {
    const out = toUserRow({ ...user, fullName: null, suspendedAt: later }, { plan: "free", lastActive: null });
    expect(out.status).toBe("suspended");
    expect(out.name).toBe("alice");
    expect(out.lastActive).toBeNull();
  });

  it("toSessionRow", () => {
    const out = toSessionRow(session);
    expect(Object.keys(out).sort()).toEqual([
      "browser", "createdAt", "extensionVersion", "id", "ip", "kind", "lastActiveAt", "locked", "os",
    ]);
    expect(out.extensionVersion).toBeNull();
    expect(out).toMatchObject({ browser: "Chrome", os: "Windows", locked: false });
    expect(JSON.stringify(out)).not.toContain(S);
    expect(toSessionRow({ ...session, lockedAt: later }).locked).toBe(true);
  });

  it("toSubscriptionRow", () => {
    const out = toSubscriptionRow(subscription);
    expect(Object.keys(out).sort()).toEqual([
      "cancelAtPeriodEnd", "currentPeriodEnd", "graceEndsAt", "id", "interval", "plan", "seats",
      "status", "stripeManaged", "trialEndsAt",
    ]);
    expect(out.stripeManaged).toBe(true);
    expect(toSubscriptionRow({ ...subscription, stripeSubscriptionId: null }).stripeManaged).toBe(false);
    expect(JSON.stringify(out)).not.toContain(S);
  });

  it("toActivityRow", () => {
    const out = toActivityRow(auditEvent);
    expect(Object.keys(out).sort()).toEqual(["action", "at"]);
    expect(out).toEqual({ action: "login", at: later.toISOString() });
    const json = JSON.stringify(out);
    expect(json).not.toContain(S);
    expect(json).not.toContain("123456");
    expect(json).not.toContain("654321");
  });

  it("toUserDetail", () => {
    const parts: UserDetailParts = {
      user,
      passkeys: [passkey],
      emergencyContacts: 2,
      sessions: [session],
      usage: {
        itemsByCategory: { login: 4, card: 1 },
        collections: 2,
        sharesSent: 1,
        sharesReceived: 0,
        attachmentBytes: 2048,
        lastItemChangeAt: later,
      },
      subscriptions: [subscription],
      companies: [membership],
      activity: [auditEvent],
      staffActions: [adminAction],
      supportRequests: [supportRequest],
    };
    const out = toUserDetail(parts);
    expect(Object.keys(out).sort()).toEqual([
      "account", "activity", "companies", "security", "sessions", "staffActions", "subscriptions", "supportRequests", "usage",
    ]);
    expect(Object.keys(out.account).sort()).toEqual(["createdAt", "email", "id", "name", "status", "suspendedAt"]);
    expect(Object.keys(out.security).sort()).toEqual([
      "emergencyContacts", "e2e", "lastPasswordResetRequestAt", "mustChangeMasterPassword",
      "passkeys", "recoveryCodesLeft", "recoveryKey", "twoFactor",
    ].sort());
    expect(Object.keys(out.security.passkeys[0]).sort()).toEqual(["createdAt", "lastUsedAt", "name"]);
    expect(Object.keys(out.usage).sort()).toEqual([
      "attachmentBytes", "collections", "itemsByCategory", "lastItemChangeAt", "sharesReceived", "sharesSent",
    ]);
    expect(Object.keys(out.companies[0]).sort()).toEqual(["id", "name", "role"]);
    expect(Object.keys(out.supportRequests[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "kind", "status"]);
    expect(out.security.recoveryCodesLeft).toBe(3);
    expect(out.security.recoveryKey).toBe(true);
    expect(out.security.emergencyContacts).toBe(2);
    expect(out.security.lastPasswordResetRequestAt).toBe("2026-02-03T04:00:00.000Z");
    expect(out.sessions[0].browser).toBe("Chrome");
    expect(out.activity[0]).toEqual({ action: "login", at: later.toISOString() });
    const json = JSON.stringify(out);
    expect(json).not.toContain(S);
    expect(json).not.toContain("123456");
  });

  it("toUserDetail: no codes, no recovery key, no reset request", () => {
    const out = toUserDetail({
      user: { ...user, twoFactorRecoveryCodes: null, recoveryProtectedUserKey: null, passwordResetExpires: null },
      passkeys: [],
      emergencyContacts: 0,
      sessions: [],
      usage: { itemsByCategory: {}, collections: 0, sharesSent: 0, sharesReceived: 0, attachmentBytes: 0, lastItemChangeAt: null },
      subscriptions: [],
      companies: [],
      activity: [],
      staffActions: [],
      supportRequests: [],
    });
    expect(out.security.recoveryCodesLeft).toBe(0);
    expect(out.security.recoveryKey).toBe(false);
    expect(out.security.lastPasswordResetRequestAt).toBeNull();
    expect(out.usage.lastItemChangeAt).toBeNull();
  });

  it("toCompanyRow", () => {
    const out = toCompanyRow(company, {
      owner,
      seatsUsed: 3,
      subscription: companySub,
    });
    expect(Object.keys(out).sort()).toEqual([
      "createdAt", "discount", "id", "markedForRemovalAt", "name", "owner", "seatsUsed", "status",
      "subscription", "suspendedAt",
    ]);
    expect(Object.keys(out.owner!).sort()).toEqual(["email", "userId"]);
    expect(JSON.stringify(out)).not.toContain(S);
  });

  it("toCompanyDetail", () => {
    const out = toCompanyDetail({
      company,
      owner,
      seatsUsed: 3,
      subscription: companySub,
      members: [member],
      groups: [group],
    });
    expect(Object.keys(out).sort()).toEqual([
      "createdAt", "discount", "groups", "id", "markedForRemovalAt", "members", "name", "owner",
      "policies", "recovery", "seatsUsed", "status", "subscription", "suspendedAt",
    ]);
    expect(Object.keys(out.members[0]).sort()).toEqual(["email", "joinedAt", "role", "status", "twoFactor", "userId"]);
    expect(Object.keys(out.groups[0]).sort()).toEqual(["id", "members", "name"]);
    expect(Object.keys(out.policies).sort()).toEqual(["maxIdleMinutes", "maxSessionDays", "minPasswordLength", "require2fa"]);
    expect(out.policies).toEqual({ require2fa: true, minPasswordLength: 12, maxSessionDays: null, maxIdleMinutes: 30 });
    expect(out.recovery).toBe(true);
    expect(out.discount).toBe("school");
    expect(JSON.stringify(out)).not.toContain(S);
  });

  it("toCompanyDetail: no owner, no subscription, no recovery, default policies", () => {
    const out = toCompanyDetail({
      company: { ...company, policies: {}, recoveryPublicKey: null, discount: null },
      owner: null,
      seatsUsed: 0,
      subscription: null,
      members: [],
      groups: [],
    });
    expect(out.owner).toBeNull();
    expect(out.subscription).toBeNull();
    expect(out.recovery).toBe(false);
    expect(out.policies).toEqual({ require2fa: false, minPasswordLength: null, maxSessionDays: null, maxIdleMinutes: null });
  });
});

describe("parseUserAgent", () => {
  const ua = {
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    linux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  it("tells Edge from Chrome", () => {
    expect(parseUserAgent(ua.edge)).toEqual({ browser: "Edge", os: "Windows" });
    expect(parseUserAgent(ua.chrome)).toEqual({ browser: "Chrome", os: "Windows" });
  });

  it("tells iOS from macOS", () => {
    expect(parseUserAgent(ua.macSafari)).toEqual({ browser: "Safari", os: "macOS" });
    expect(parseUserAgent(ua.iphone)).toEqual({ browser: "Safari", os: "iOS" });
    expect(parseUserAgent(ua.ipad)).toEqual({ browser: "Safari", os: "iOS" });
  });

  it("tells Android from Linux", () => {
    expect(parseUserAgent(ua.android)).toEqual({ browser: "Chrome", os: "Android" });
    expect(parseUserAgent(ua.linux)).toEqual({ browser: "Chrome", os: "Linux" });
    expect(parseUserAgent(ua.firefox)).toEqual({ browser: "Firefox", os: "Linux" });
  });

  it("falls back to Other", () => {
    expect(parseUserAgent(null)).toEqual({ browser: "Other", os: "Other" });
    expect(parseUserAgent("curl/8.0")).toEqual({ browser: "Other", os: "Other" });
  });
});

describe("USER_ACTIVITY_ACTIONS", () => {
  it("has support_action and no secret_link_ entry", () => {
    expect(USER_ACTIVITY_ACTIONS).toContain("support_action");
    expect(USER_ACTIVITY_ACTIONS.some((action) => action.startsWith("secret_link_"))).toBe(false);
    expect(USER_ACTIVITY_ACTIONS).toContain("login");
    expect(new Set(USER_ACTIVITY_ACTIONS).size).toBe(USER_ACTIVITY_ACTIONS.length);
  });
});
