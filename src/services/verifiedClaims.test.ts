import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Collection from "@src/models/Collection";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import EmergencyContact from "@src/models/EmergencyContact";
import FamilyMember from "@src/models/FamilyMember";
import Note from "@src/models/Note";
import User from "@src/models/User";
import CollectionService from "@src/services/CollectionService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import CompanyService from "@src/services/CompanyService";
import EmergencyAccessService from "@src/services/EmergencyAccessService";
import FamilyService from "@src/services/FamilyService";
import NoteService from "@src/services/NoteService";
import StripeService from "@src/services/StripeService";
import UserService from "@src/services/UserService";
import UserPasskey from "@src/models/UserPasskey";
import AuthService from "@src/services/AuthService";
import NotificationService from "@src/services/NotificationService";
import EmailService from "@src/services/EmailService";
import EntitlementService from "@src/services/EntitlementService";
import SessionService from "@src/services/SessionService";
import StaffService from "@src/services/admin/StaffService";
import AdminStaff from "@src/models/AdminStaff";
import { table } from "@src/services/recoveryTestDb";

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

let db: Record<string, any[]>;

// Nia (5) signed up as nia@acme.com but hasn't confirmed it; Olga (1) is confirmed.
beforeEach(() => {
  vi.spyOn(StripeService, "syncSeatsLater").mockImplementation(() => undefined as never);
  vi.spyOn(CompanyPolicyService, "clear").mockImplementation(() => undefined as never);
  db = {
    users: table(User, [
      { id: 1, email: "olga@acme.com", username: "olga", emailVerifiedAt: new Date("2026-01-01") },
      { id: 5, email: "nia@acme.com", username: "nia", emailVerifiedAt: null },
    ]),
    companies: table(Company, [{ id: 7, name: "Acme", status: "active" }]),
    members: table(CompanyMember, [
      { id: 21, companyId: 7, email: "nia@acme.com", userId: null, role: "member", status: "invited", expiresAt: null, inviteTokenHash: sha256("tok"), inviteEmailed: true },
    ]),
    family: table(FamilyMember, [{ id: 31, ownerId: 1, email: "nia@acme.com", userId: null, status: "invited" }]),
    emergency: table(EmergencyContact, [{ id: 41, grantorId: 1, email: "nia@acme.com", contactId: null, status: "invited" }]),
    collections: table(Collection, [{ id: 60, userId: 1, companyId: null }]),
    notes: table(Note, [{ id: 70, userId: 1, companyId: null }]),
    staff: table(AdminStaff, []),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("invites sent to an address wait until it's confirmed", () => {
  it("company, family and emergency invites aren't claimed by an unconfirmed account", async () => {
    await CompanyService.claimInvites(5, "nia@acme.com");
    await FamilyService.claimInvites(5, "nia@acme.com");
    await EmergencyAccessService.claimInvites(5, "nia@acme.com");
    expect(db.members[0].userId).toBeNull();
    expect(db.family[0].userId).toBeNull();
    expect(db.emergency[0].contactId).toBeNull();
  });

  it("after confirming, they are", async () => {
    db.users[1].emailVerifiedAt = new Date();
    await CompanyService.claimInvites(5, "nia@acme.com");
    await FamilyService.claimInvites(5, "nia@acme.com");
    await EmergencyAccessService.claimInvites(5, "nia@acme.com");
    expect(db.members[0].userId).toBe(5);
    expect(db.family[0].userId).toBe(5);
    expect(db.emergency[0].contactId).toBe(5);
  });

  it("joining with the company invite link confirms the address (the link came to that inbox)", async () => {
    vi.spyOn(CompanyService as any, "summary").mockResolvedValue({ id: 7 });
    await CompanyService.accept(7, 5, "tok");
    expect(db.users[1].emailVerifiedAt).toBeInstanceOf(Date);
    expect(db.members[0]).toMatchObject({ userId: 5, status: "active" });
  });

  it("a link the inviter got to pass on (email off) doesn't confirm: it never reached the inbox", async () => {
    db.members[0].inviteEmailed = false;
    vi.spyOn(CompanyService as any, "summary").mockResolvedValue({ id: 7 });
    await failure(CompanyService.accept(7, 5, "tok"));
    expect(db.users[1].emailVerifiedAt).toBeNull();
  });

  it("invites record whether the link was emailed", async () => {
    db.members.push({ id: 22, companyId: 7, userId: 1, role: "owner", status: "active" });
    db.users[0].emailVerifiedAt = new Date();
    vi.spyOn(EmailService, "sendCompanyInvite").mockResolvedValueOnce(true as never).mockResolvedValueOnce(false as never);
    vi.spyOn(CompanyService as any, "requireManager").mockResolvedValue({ role: "owner", email: "olga@acme.com" });
    await CompanyService.invite(7, 1, "lee@acme.com", "member").catch(() => undefined);
    await CompanyService.invite(7, 1, "max@acme.com", "member").catch(() => undefined);
    expect(db.members.find((row) => row.email === "lee@acme.com")?.inviteEmailed).toBe(true);
    expect(db.members.find((row) => row.email === "max@acme.com")?.inviteEmailed).toBe(false);
  });

  it("a wrong invite token neither confirms nor joins", async () => {
    expect((await failure(CompanyService.accept(7, 5, "nope"))).status).toBeGreaterThanOrEqual(400);
    expect(db.users[1].emailVerifiedAt).toBeNull();
    expect(db.members[0].userId).toBeNull();
  });
});

describe("unconfirmed accounts can't be found or shared with by email", () => {
  it("search leaves them out", async () => {
    // Outside a company, search needs the exact address (SEC06).
    expect((await UserService.searchUsers("olga@acme.com", 9)).map((user: any) => user.id)).toEqual([1]);
    expect(await UserService.searchUsers("nia@acme.com", 9)).toEqual([]);
  });

  it("sharing a collection to an unconfirmed address says so", async () => {
    const err = await failure(CollectionService.share(60, 1, "nia@acme.com"));
    expect(err).toMatchObject({ status: 404, message: 'No confirmed account with email or username "nia@acme.com"' });
  });

  it("sharing an item to an unconfirmed address says so", async () => {
    vi.spyOn(NoteService as any, "getNoteAccess").mockResolvedValue({ note: db.notes[0], permission: "owner" });
    const err = await failure(NoteService.shareNote(70, 1, "nia@acme.com"));
    expect(err).toMatchObject({ status: 404, message: 'No confirmed account with email or username "nia@acme.com"' });
  });
});

describe("mid review: an address gives nothing to an unconfirmed account, even when it signed up first", () => {
  beforeEach(() => {
    db.users.push(
      { id: 6, email: "kim@acme.com", username: "kim", emailVerifiedAt: null },
      { id: 8, email: "kimyx@acme.com", username: "kimyx", emailVerifiedAt: new Date("2026-01-01") }
    );
    db.users[0].e2eEnabled = true;
    vi.spyOn(EntitlementService, "forUser").mockResolvedValue({ limits: { emergencyAccess: true } } as never);
    vi.spyOn(EntitlementService, "forFamily").mockResolvedValue({ plan: "family" } as never);
    vi.spyOn(EmailService, "sendEmergencyInvite").mockResolvedValue(true as never);
    vi.spyOn(EmailService, "sendFamilyInvite").mockResolvedValue(true as never);
    vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
  });

  it("C1: an emergency invite to an unconfirmed account waits (no contactId)", async () => {
    await EmergencyAccessService.invite(1, { email: "kim@acme.com", waitDays: 7 });
    expect(db.emergency.find((row) => row.email === "kim@acme.com")?.contactId).toBeNull();
  });

  it("C1: a family invite to an unconfirmed account waits (no userId)", async () => {
    await FamilyService.invite(1, "kim@acme.com");
    expect(db.family.find((row) => row.email === "kim@acme.com")?.userId).toBeNull();
  });

  it("C1: an invite already tied to an unconfirmed account can't be accepted", async () => {
    db.family.push({ id: 32, ownerId: 1, email: "kim@acme.com", userId: 6, status: "invited", expiresAt: null });
    db.emergency.push({ id: 42, grantorId: 1, email: "kim@acme.com", contactId: 6, status: "invited" });
    expect((await failure(FamilyService.accept(6, 32))).status).toBe(403);
    expect((await failure(EmergencyAccessService.accept(6, 42))).status).toBe(403);
  });

  it("I1: a company invite to an unconfirmed account isn't tied to it", async () => {
    db.members.push({ id: 22, companyId: 7, userId: 1, role: "owner", status: "active" });
    vi.spyOn(EmailService, "sendCompanyInvite").mockResolvedValue(true as never);
    await CompanyService.invite(7, 1, "kim@acme.com", "member").catch(() => undefined);
    const row = db.members.find((member) => member.email === "kim@acme.com");
    expect(row?.userId ?? null).toBeNull();
  });

  it("I2: an underscore in an invited address doesn't match a different confirmed address", async () => {
    await EmergencyAccessService.invite(1, { email: "kim_x@acme.com", waitDays: 7 });
    expect(db.emergency.find((row) => row.email === "kim_x@acme.com")?.contactId).toBeNull();
  });

  it("I3: staff can't be added to an unconfirmed account, and ADMIN_EMAILS needs a confirmed one", async () => {
    expect((await failure(StaffService.add("kim@acme.com", "support" as never, 1))).status).toBe(404);
    vi.stubEnv("ADMIN_EMAILS", "kim@acme.com");
    expect(await StaffService.roleOf(6)).toBeNull();
    db.users.find((user) => user.id === 6)!.emailVerifiedAt = new Date();
    expect(await StaffService.roleOf(6)).toBe("admin");
    vi.unstubAllEnvs();
  });
});
