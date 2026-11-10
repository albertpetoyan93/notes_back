import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import User from "@src/models/User";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import CompanyService from "@src/services/CompanyService";
import EmailService from "@src/services/EmailService";
import StripeService from "@src/services/StripeService";

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

const company = { id: 7, name: "Acme", status: "active", policies: {}, update: vi.fn() };

beforeEach(() => {
  vi.spyOn(User, "findByPk").mockResolvedValue({ id: 1, email: "boss@acme.com" } as never);
  vi.spyOn(Company, "findByPk").mockResolvedValue(company as never);
  vi.spyOn(CompanyMember, "update").mockResolvedValue([0] as never);
  vi.spyOn(StripeService, "syncSeatsLater").mockImplementation(() => undefined as never);
  vi.spyOn(CompanyPolicyService, "clear").mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CompanyService.invite: a single-use token sent by email", () => {
  beforeEach(() => {
    // The caller manages the company; the invited person has no row yet.
    vi.spyOn(CompanyMember, "findOne")
      .mockResolvedValueOnce({ id: 1, role: "owner" } as never)
      .mockResolvedValueOnce(null as never);
    vi.spyOn(User, "findOne").mockResolvedValue(null as never);
  });

  it("stores only the token's hash and puts the token in the emailed link", async () => {
    const create = vi.spyOn(CompanyMember, "create").mockImplementation(async (values: any) => ({ id: 9, ...values }) as never);
    const send = vi.spyOn(EmailService, "sendCompanyInvite").mockResolvedValue(true as never);

    const result: any = await CompanyService.invite(7, 1, "Sam@Example.com", "member");

    const stored = (create.mock.calls[0][0] as any).inviteTokenHash;
    const token = (send.mock.calls[0][0] as any).token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored).toBe(sha256(token));
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain(token);
    // Delivered by email: the link is not handed back to the inviter.
    expect(result.inviteLink).toBeUndefined();
  });

  it("gives the inviter the link to send themselves when email isn't set up", async () => {
    vi.spyOn(CompanyMember, "create").mockImplementation(async (values: any) => ({ id: 9, ...values }) as never);
    const send = vi.spyOn(EmailService, "sendCompanyInvite").mockResolvedValue(false as never);

    const result: any = await CompanyService.invite(7, 1, "sam@example.com", "member");

    const token = (send.mock.calls[0][0] as any).token;
    expect(result.inviteLink).toContain(`/invite?company=7&token=${token}`);
  });

  it("re-inviting replaces the token, so an older link stops working", async () => {
    vi.mocked(CompanyMember.findOne).mockReset();
    const existing: any = { id: 9, status: "invited", role: "member", userId: null, expiresAt: new Date(0), inviteTokenHash: sha256("old"), update: vi.fn(async function (this: any, v: any) { Object.assign(existing, v); return existing; }) };
    vi.spyOn(CompanyMember, "findOne")
      .mockResolvedValueOnce({ id: 1, role: "owner" } as never)
      .mockResolvedValueOnce(existing as never);
    const send = vi.spyOn(EmailService, "sendCompanyInvite").mockResolvedValue(true as never);

    await CompanyService.invite(7, 1, "sam@example.com", "member");

    const token = (send.mock.calls[0][0] as any).token;
    expect(existing.inviteTokenHash).toBe(sha256(token));
    expect(existing.inviteTokenHash).not.toBe(sha256("old"));
  });
});

describe("CompanyService.accept: only with the emailed token", () => {
  let member: any;

  beforeEach(() => {
    member = {
      id: 9,
      role: "member",
      status: "invited",
      inviteTokenHash: sha256("right-token"),
      get: () => company,
      update: vi.fn(async (values: any) => Object.assign(member, values)),
    };
    vi.spyOn(CompanyMember, "findOne").mockResolvedValue(member as never);
  });

  it("joins with the right token, and the token can't be used again", async () => {
    const summary = await CompanyService.accept(7, 5, "right-token");
    expect(member.update).toHaveBeenCalledWith({ status: "active", expiresAt: null, inviteTokenHash: null });
    expect(summary.memberStatus).toBe("active");
  });

  it("refuses a wrong or missing token (403) and changes nothing", async () => {
    expect((await failure(CompanyService.accept(7, 5, "wrong-token"))).status).toBe(403);
    expect((await failure(CompanyService.accept(7, 5, ""))).status).toBe(403);
    expect((await failure(CompanyService.accept(7, 5, undefined))).status).toBe(403);
    expect(member.update).not.toHaveBeenCalled();
  });

  it("refuses an invite made before tokens existed: it needs a new invite", async () => {
    member.inviteTokenHash = null;
    const err = await failure(CompanyService.accept(7, 5, "anything"));
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/new invite/i);
  });
});
