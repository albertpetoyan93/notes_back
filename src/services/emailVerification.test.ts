import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CompanyMember from "@src/models/CompanyMember";
import EmergencyContact from "@src/models/EmergencyContact";
import FamilyMember from "@src/models/FamilyMember";
import Note from "@src/models/Note";
import Subscription from "@src/models/Subscription";
import AdminStaff from "@src/models/AdminStaff";
import Collection from "@src/models/Collection";
import SecretLink from "@src/models/SecretLink";
import SupportRequest from "@src/models/SupportRequest";
import User from "@src/models/User";
import EmailService from "@src/services/EmailService";
import EmailVerificationService from "@src/services/EmailVerificationService";
import { table } from "@src/services/recoveryTestDb";

const DAY = 24 * 3600 * 1000;
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

let db: Record<string, any[]>;
const now = new Date("2026-11-20T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  db = {
    users: table(User, [
      { id: 1, email: "new@example.com", emailVerifiedAt: null, createdAt: new Date(now.getTime() - DAY) },
      { id: 2, email: "old-empty@example.com", emailVerifiedAt: null, createdAt: new Date(now.getTime() - 8 * DAY) },
      { id: 3, email: "recent@example.com", emailVerifiedAt: null, createdAt: new Date(now.getTime() - 6 * DAY) },
      { id: 4, email: "old-member@example.com", emailVerifiedAt: null, createdAt: new Date(now.getTime() - 8 * DAY) },
      { id: 5, email: "old-items@example.com", emailVerifiedAt: null, createdAt: new Date(now.getTime() - 8 * DAY) },
      { id: 6, email: "confirmed@example.com", emailVerifiedAt: new Date(now.getTime() - 30 * DAY), createdAt: new Date(now.getTime() - 30 * DAY) },
    ]),
    members: table(CompanyMember, [{ id: 1, companyId: 7, userId: 4, status: "invited" }]),
    notes: table(Note, [{ id: 1, userId: 5, companyId: null }]),
    family: table(FamilyMember, []),
    emergency: table(EmergencyContact, []),
    subscriptions: table(Subscription, []),
    staff: table(AdminStaff, []),
    support: table(SupportRequest, []),
    links: table(SecretLink, []),
    collections: table(Collection, []),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("issue + confirm", () => {
  it("emails a single-use link and stores only its hash", async () => {
    const send = vi.spyOn(EmailService, "sendEmailConfirmation").mockResolvedValue(true as never);
    await EmailVerificationService.issue((await User.findByPk(1)) as never);
    const token = (send.mock.calls[0][0] as any).token;
    expect(db.users[0].emailVerifyTokenHash).toBe(hash(token));
    expect(db.users[0].emailVerifyExpires.getTime()).toBe(now.getTime() + DAY);
  });

  it("confirms by token, whoever is signed in, and the link works once", async () => {
    vi.spyOn(EmailService, "sendEmailConfirmation").mockResolvedValue(true as never);
    await EmailVerificationService.issue((await User.findByPk(1)) as never);
    const token = (vi.mocked(EmailService.sendEmailConfirmation).mock.calls[0][0] as any).token;
    expect(await EmailVerificationService.confirm(token)).toEqual({ email: "new@example.com" });
    expect(db.users[0].emailVerifiedAt).toEqual(now);
    expect(db.users[0].emailVerifyTokenHash).toBeNull();
    expect((await failure(EmailVerificationService.confirm(token))).status).toBe(404);
  });

  it("refuses an expired link", async () => {
    Object.assign(db.users[0], { emailVerifyTokenHash: hash("t"), emailVerifyExpires: new Date(now.getTime() - 1) });
    expect((await failure(EmailVerificationService.confirm("t"))).status).toBe(404);
  });
});

describe("resend", () => {
  it("is refused for a confirmed account, and within 60 s of the last link", async () => {
    vi.spyOn(EmailService, "sendEmailConfirmation").mockResolvedValue(true as never);
    expect((await failure(EmailVerificationService.resend(6))).status).toBe(409);
    await EmailVerificationService.resend(1);
    expect((await failure(EmailVerificationService.resend(1))).status).toBe(429);
    vi.setSystemTime(new Date(now.getTime() + 61_000));
    await EmailVerificationService.resend(1);
  });
});

describe("purgeUnconfirmed", () => {
  it("removes unconfirmed accounts older than 7 days that have nothing; keeps the rest", async () => {
    const removed = await EmailVerificationService.purgeUnconfirmed(now);
    expect(removed).toBe(1);
    expect(db.users.map((user) => user.id).sort()).toEqual([1, 3, 4, 5, 6]);
  });
});

describe("purgeUnconfirmed keeps accounts that hold anything", () => {
  it("staff role, support request, live secret link or a collection keeps the account", async () => {
    const old = new Date(now.getTime() - 8 * DAY);
    db.users.push(
      { id: 10, email: "staff@example.com", emailVerifiedAt: null, createdAt: old },
      { id: 11, email: "ticket@example.com", emailVerifiedAt: null, createdAt: old },
      { id: 12, email: "link@example.com", emailVerifiedAt: null, createdAt: old },
      { id: 13, email: "folder@example.com", emailVerifiedAt: null, createdAt: old }
    );
    db.staff.push({ userId: 10, role: "support" });
    db.support.push({ id: 1, userId: 11 });
    db.links.push({ id: 1, createdBy: 12 });
    db.collections.push({ id: 1, userId: 13 });
    await EmailVerificationService.purgeUnconfirmed(now);
    expect(db.users.map((user) => user.id)).toEqual(expect.arrayContaining([10, 11, 12, 13]));
  });
});

describe("sign-up", () => {
  it("sends the new account a confirmation link", async () => {
    const issue = vi.spyOn(EmailVerificationService, "issue").mockResolvedValue(undefined as never);
    const AuthService = (await import("@src/services/AuthService")).default;
    const CompanyService = (await import("@src/services/CompanyService")).default;
    const FamilyService = (await import("@src/services/FamilyService")).default;
    vi.spyOn(CompanyService, "claimInvites").mockResolvedValue(undefined as never);
    vi.spyOn(FamilyService, "claimInvites").mockResolvedValue(undefined as never);
    const user = await AuthService.register({ username: "kim", email: "kim@example.com", password: "x", fullName: "Kim" } as never);
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ id: user.id, email: "kim@example.com" }));
  });
});

describe("isVerified", () => {
  it("is true only with a confirmation time", () => {
    expect(EmailVerificationService.isVerified(db.users[0] as never)).toBe(false);
    expect(EmailVerificationService.isVerified(db.users[5] as never)).toBe(true);
  });
});
