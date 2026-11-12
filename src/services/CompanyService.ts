import CollectionService from "./CollectionService";
import crypto from "crypto";
import EmailVerificationService from "./EmailVerificationService";
import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Company, { type CompanyPolicies } from "../models/Company";
import CompanyMember, { CompanyRole } from "../models/CompanyMember";
import { RecoveryCustodian } from "../models/CompanyRecovery";
import User from "../models/User";
import { formatCompanyName } from "../util/formatCompanyName";
import CompanyBilling from "./CompanyBilling";
import CompanyPolicyService from "./CompanyPolicyService";
import EmailService from "./EmailService";
import GroupService from "./GroupService";
import OffboardingService from "./OffboardingService";
import StripeService from "./StripeService";

const INVITE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Invites are bound to the inbox they were sent to (F15): accepting needs the
 * single-use token from the email. Sign-up doesn't verify email addresses, so
 * the address alone isn't enough. Only the hash is stored.
 */
const hashInviteToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const inviteTokenMatches = (token: unknown, hash: string | null | undefined) => {
  if (typeof token !== "string" || !token || !hash) return false;
  const given = Buffer.from(hashInviteToken(token), "hex");
  const stored = Buffer.from(hash, "hex");
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
};

export interface CompanySummary {
  id: number;
  name: string;
  status: "active" | "suspended";
  role: "owner" | "admin" | "member";
  memberStatus: "invited" | "active" | "suspended" | "removed";
  expiresAt: string | null;
  /** The company's rules, so the vault can explain them (e.g. password length). */
  policies: CompanyPolicies;
  /** Set when the company's rules keep its items closed to this person. */
  blocked: "2fa" | null;
  /** A new company's Team trial end. */
  trialEndsAt?: string | null;
}

class CompanyService {
  async claimInvites(userId: number, email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    // Only an account that proved it owns the address gets what was sent to it (F15).
    if (!(await EmailVerificationService.isVerifiedId(userId))) return;
    await CompanyMember.update(
      { userId },
      {
        where: {
          email: normalized,
          userId: { [Op.is]: null },
          status: "invited",
        },
      }
    );
  }

  async list(userId: number): Promise<CompanySummary[]> {
    const user = await User.findByPk(userId, { attributes: ["id", "email"] });
    if (user) await this.claimInvites(userId, user.email);

    const members = await CompanyMember.findAll({
      where: {
        userId,
        [Op.or]: [
          { status: "active" },
          {
            status: "invited",
            [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
          },
        ],
      },
      include: [
        {
          model: Company,
          as: "company",
          attributes: ["id", "name", "status", "policies"],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

    const { blocked } = await CompanyPolicyService.forUser(userId);
    const summaries: CompanySummary[] = [];
    for (const member of members) {
      const company = member.get("company") as Company | undefined;
      if (!company) continue;
      const formattedName = formatCompanyName(company.name);
      if (formattedName && formattedName !== company.name) {
        await company.update({ name: formattedName });
      }
      summaries.push({
        id: company.id,
        name: company.name,
        status: company.status,
        role: member.role,
        memberStatus: member.status,
        expiresAt: member.expiresAt ? member.expiresAt.toISOString() : null,
        policies: CompanyPolicyService.clean(company.policies || {}),
        blocked: blocked.has(company.id) ? "2fa" : null,
      });
    }
    return summaries;
  }

  async create(userId: number, name: string): Promise<CompanySummary> {
    const trimmed = formatCompanyName(name);
    if (!trimmed) {
      throw Object.assign(new Error("Enter a company name"), { status: 400 });
    }

    const user = await User.findByPk(userId, { attributes: ["id", "email"] });
    if (!user) {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    }

    const transaction = await sequelize.transaction();
    try {
      const company = await Company.create(
        { name: trimmed, status: "active" },
        { transaction }
      );
      await CompanyMember.create(
        {
          companyId: company.id,
          userId,
          email: user.email.trim().toLowerCase(),
          role: "owner",
          status: "active",
        },
        { transaction }
      );
      await transaction.commit();
      // Every company starts on a free 14-day Team trial.
      const trial = await CompanyBilling.startTrial(company.id);
      return {
        id: company.id,
        name: company.name,
        status: company.status,
        role: "owner",
        memberStatus: "active",
        expiresAt: null,
        policies: CompanyPolicyService.clean({}),
        blocked: null,
        trialEndsAt: trial?.trialEndsAt ? new Date(trial.trialEndsAt).toISOString() : null,
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async members(companyId: number, userId: number) {
    await this.requireManager(companyId, userId);
    const rows = await CompanyMember.findAll({
      where: {
        companyId,
        [Op.or]: [
          { status: "active" },
          // Being offboarded: managers need to see who.
          { status: "suspended" },
          { status: "removed" },
          {
            status: "invited",
            [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
          },
        ],
      },
      order: [["createdAt", "ASC"]],
    });
    // Whether each person has end-to-end encryption on (only they can receive vault keys).
    const userIds = rows.map((member) => member.userId).filter((id): id is number => !!id);
    const keyed = new Set(
      userIds.length
        ? (await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ["id", "e2eEnabled"] }))
            .filter((user) => user.e2eEnabled)
            .map((user) => user.id)
        : []
    );
    return rows.map((member) => ({
      id: member.id,
      userId: member.userId ?? null,
      email: member.email,
      role: member.role,
      status: member.status,
      expiresAt: member.expiresAt ? member.expiresAt.toISOString() : null,
      e2eEnabled: !!member.userId && keyed.has(member.userId),
    }));
  }

  async invite(companyId: number, userId: number, email: string, role: string) {
    const manager = await this.requireManager(companyId, userId);
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw Object.assign(new Error("Enter a valid email"), { status: 400 });
    }
    if (normalized === manager.email.trim().toLowerCase()) {
      throw Object.assign(new Error("You are already in this company"), { status: 400 });
    }
    const nextRole: CompanyRole = role === "admin" ? "admin" : "member";
    // Tied to an account only once it confirmed the address; otherwise claimInvites (or the invite link) does it.
    const existingUser = await EmailVerificationService.confirmedAccountByEmail(normalized, ["id", "email"]);
    const expiresAt = new Date(Date.now() + INVITE_MS);
    const existing = await CompanyMember.findOne({
      where: { companyId, email: normalized },
    });

    if (existing?.status === "active") {
      throw Object.assign(new Error("That person is already in this company"), {
        status: 400,
      });
    }
    // Re-inviting would bring them back mid-offboarding and leave it unable to finish.
    if (existing?.status === "suspended") {
      throw Object.assign(new Error("This person is being offboarded. Finish their offboarding first."), {
        status: 409,
      });
    }
    if (
      existing?.status === "invited" &&
      existing.expiresAt &&
      existing.expiresAt > new Date()
    ) {
      throw Object.assign(new Error("That person is already invited"), { status: 400 });
    }

    // A new token each time: re-inviting makes any older link stop working.
    const token = crypto.randomBytes(32).toString("base64url");
    const inviteTokenHash = hashInviteToken(token);
    const previous = existing
      ? {
          status: existing.status,
          role: existing.role,
          userId: existing.userId,
          expiresAt: existing.expiresAt,
          inviteTokenHash: existing.inviteTokenHash ?? null,
        }
      : null;
    const member = existing
      ? await existing.update({
          status: "invited",
          role: nextRole,
          userId: existing.userId || existingUser?.id || null,
          expiresAt,
          inviteTokenHash,
          inviteEmailed: false,
        })
      : await CompanyMember.create({
          companyId,
          email: normalized,
          userId: existingUser?.id || null,
          role: nextRole,
          status: "invited",
          expiresAt,
          inviteTokenHash,
          inviteEmailed: false,
        });

    const company = await Company.findByPk(companyId);
    const companyName = formatCompanyName(company?.name || "") || "A Company";
    if (company && companyName !== company.name) {
      await company.update({ name: companyName });
    }

    let emailSent = false;
    try {
      emailSent = await EmailService.sendCompanyInvite({
        to: normalized,
        companyId,
        companyName,
        token,
      });
    } catch (error) {
      if (previous && existing) await existing.update(previous);
      else await member.destroy();
      throw error;
    }
    if (emailSent) await CompanyMember.update({ inviteEmailed: true }, { where: { id: member.id } });

    return {
      id: member.id,
      email: member.email,
      role: member.role,
      status: member.status,
      expiresAt: member.expiresAt ? member.expiresAt.toISOString() : null,
      emailSent,
      // Email isn't set up: the inviter sends the link themselves. Never when it was emailed.
      ...(emailSent ? {} : { inviteLink: EmailService.companyInviteLink(companyId, token) }),
    };
  }

  async rename(companyId: number, userId: number, name: string) {
    await this.requireManager(companyId, userId);
    const trimmed = formatCompanyName(name);
    if (!trimmed) {
      throw Object.assign(new Error("Enter a company name"), { status: 400 });
    }
    const company = await Company.findByPk(companyId);
    if (!company) throw Object.assign(new Error("Company not found"), { status: 404 });
    await company.update({ name: trimmed });
    return { id: company.id, name: company.name, status: company.status };
  }

  async updateMemberRole(companyId: number, userId: number, memberId: number, role: string) {
    await this.requireOwner(companyId, userId);
    const nextRole: CompanyRole = role === "admin" ? "admin" : "member";
    const member = await CompanyMember.findOne({ where: { id: memberId, companyId } });
    if (!member || member.role === "owner") {
      throw Object.assign(new Error("That role cannot be changed"), { status: 400 });
    }
    await member.update({ role: nextRole });
    // Custodians are owners/admins: a member is no longer one (made admin again, the owner chooses anew).
    if (nextRole === "member" && member.userId) {
      await RecoveryCustodian.destroy({ where: { companyId, userId: member.userId } });
      // ADR-002: access kept "as admin" ends with the role (key tasks then replace the vault keys).
      await CollectionService.dropLegacyGrants(companyId, member.userId);
    }
    return { id: member.id, role: member.role };
  }

  async removeMember(companyId: number, userId: number, memberId: number) {
    const actor = await CompanyMember.findOne({
      where: { companyId, userId, status: "active", role: { [Op.in]: ["owner", "admin"] } },
    });
    if (!actor) {
      throw Object.assign(new Error("You cannot remove people from this company"), { status: 403 });
    }
    const company = await Company.findByPk(companyId);
    if (!company || company.status !== "active") {
      throw Object.assign(new Error("Company not found"), { status: 404 });
    }
    const member = await CompanyMember.findOne({ where: { id: memberId, companyId } });
    if (!member || member.role === "owner" || member.userId === userId) {
      throw Object.assign(new Error("That person cannot be removed"), { status: 400 });
    }
    if (actor.role === "admin" && member.role !== "member") {
      throw Object.assign(new Error("Only the owner can remove an admin"), { status: 403 });
    }
    // Leaving ends their vault-recovery custody (once the removal went through; their key copy goes
    // at the next key replacement).
    const endCustody = () =>
      member.userId ? RecoveryCustodian.destroy({ where: { companyId, userId: member.userId } }) : Promise.resolve(0);
    // Someone who could open company items is suspended and offboarded, not deleted.
    // A second removal (e.g. two managers at once) gets the open offboarding back.
    if (member.status === "active" || member.status === "suspended") {
      const { offboardingId, created } = await OffboardingService.start(companyId, userId, memberId);
      await endCustody();
      return { ok: true, offboardingId, created };
    }
    await member.destroy();
    await endCustody();
    if (member.userId) await GroupService.leaveCompany(companyId, member.userId);
    return { ok: true };
  }

  /** Join with the token from the invite email; it's cleared, so the link works once. */
  async accept(companyId: number, userId: number, token: unknown) {
    const user = await this.requireUser(userId);
    if (!(await EmailVerificationService.isVerifiedId(userId))) {
      // The invite link reached this address's inbox: that confirms the address.
      const sent = await CompanyMember.findOne({
        where: { companyId, email: user.email.trim().toLowerCase(), userId: { [Op.is]: null }, status: "invited" },
      });
      // Only a link that was emailed proves the inbox; one handed to the inviter (email off) doesn't.
      if (sent?.inviteEmailed && sent.inviteTokenHash && inviteTokenMatches(token, sent.inviteTokenHash)) {
        await EmailVerificationService.markVerified(user as User);
      }
    }
    await this.claimInvites(userId, user.email);
    const member = await this.openInvite(companyId, userId);
    if (!member.inviteTokenHash) {
      throw Object.assign(new Error("This invite is from before invite links. Ask for a new invite."), { status: 403 });
    }
    if (!inviteTokenMatches(token, member.inviteTokenHash)) {
      throw Object.assign(new Error("Open the link in your invitation email to join."), { status: 403 });
    }
    await member.update({ status: "active", expiresAt: null, inviteTokenHash: null });
    // Back as a member (e.g. a former admin): grants they had as admin don't come back with them.
    if (member.role === "member") await CollectionService.dropLegacyGrants(companyId, userId);
    // Accepted members are billed (pro rata); invited people never are.
    StripeService.syncSeatsLater(companyId);
    // The company's rules (e.g. require 2FA) apply from the first request.
    CompanyPolicyService.clear(userId);
    return this.summary(member);
  }

  async decline(companyId: number, userId: number) {
    const user = await this.requireUser(userId);
    await this.claimInvites(userId, user.email);
    const member = await CompanyMember.findOne({
      where: { companyId, userId, status: "invited" },
    });
    if (!member) {
      throw Object.assign(new Error("Invite not found"), { status: 404 });
    }
    await member.destroy();
  }

  private async requireOwner(companyId: number, userId: number) {
    await this.requireManager(companyId, userId);
    const member = await CompanyMember.findOne({
      where: { companyId, userId, status: "active", role: "owner" },
    });
    if (!member) {
      throw Object.assign(new Error("Only the owner can change roles"), { status: 403 });
    }
    return member;
  }

  private async requireUser(userId: number) {
    const user = await User.findByPk(userId, { attributes: ["id", "email"] });
    if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    return user;
  }

  private async requireManager(companyId: number, userId: number) {
    const user = await this.requireUser(userId);
    const company = await Company.findByPk(companyId);
    if (!company || company.status !== "active") {
      throw Object.assign(new Error("Company not found"), { status: 404 });
    }
    const member = await CompanyMember.findOne({
      where: { companyId, userId, status: "active", role: { [Op.in]: ["owner", "admin"] } },
    });
    if (!member) {
      throw Object.assign(new Error("You cannot invite people to this company"), {
        status: 403,
      });
    }
    return user;
  }

  private async openInvite(companyId: number, userId: number) {
    const company = await Company.findByPk(companyId);
    if (!company) {
      throw Object.assign(new Error("Company not found"), { status: 404 });
    }
    if (company.status !== "active") {
      throw Object.assign(new Error("This company is not open"), { status: 400 });
    }
    const member = await CompanyMember.findOne({
      where: {
        companyId,
        userId,
        status: "invited",
        [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
      },
      include: [
        { model: Company, as: "company", attributes: ["id", "name", "status", "policies"] },
      ],
    });
    if (!member) {
      throw Object.assign(new Error("Invite not found or expired"), { status: 404 });
    }
    return member;
  }

  private summary(member: CompanyMember): CompanySummary {
    const company = member.get("company") as Company;
    return {
      id: company.id,
      name: formatCompanyName(company.name) || company.name,
      status: company.status,
      role: member.role,
      memberStatus: member.status,
      expiresAt: null,
      policies: CompanyPolicyService.clean(company.policies || {}),
      // Worked out on the next list; a new member's cached rules are cleared below.
      blocked: null,
    };
  }
}

export default new CompanyService();
