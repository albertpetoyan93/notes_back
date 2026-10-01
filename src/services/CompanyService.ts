import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Company from "../models/Company";
import CompanyMember, { CompanyRole } from "../models/CompanyMember";
import User from "../models/User";
import { formatCompanyName } from "../util/formatCompanyName";
import EmailService from "./EmailService";

const INVITE_MS = 14 * 24 * 60 * 60 * 1000;

export interface CompanySummary {
  id: number;
  name: string;
  status: "active" | "suspended";
  role: "owner" | "admin" | "member";
  memberStatus: "invited" | "active" | "removed";
  expiresAt: string | null;
}

class CompanyService {
  async claimInvites(userId: number, email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
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
          attributes: ["id", "name", "status"],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

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
      return {
        id: company.id,
        name: company.name,
        status: company.status,
        role: "owner",
        memberStatus: "active",
        expiresAt: null,
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
          { status: "removed" },
          {
            status: "invited",
            [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
          },
        ],
      },
      order: [["createdAt", "ASC"]],
    });
    return rows.map((member) => ({
      id: member.id,
      email: member.email,
      role: member.role,
      status: member.status,
      expiresAt: member.expiresAt ? member.expiresAt.toISOString() : null,
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
    const existingUser = await User.findOne({
      where: { email: { [Op.iLike]: normalized } },
      attributes: ["id", "email"],
    });
    const expiresAt = new Date(Date.now() + INVITE_MS);
    const existing = await CompanyMember.findOne({
      where: { companyId, email: normalized },
    });

    if (existing?.status === "active") {
      throw Object.assign(new Error("That person is already in this company"), {
        status: 400,
      });
    }
    if (
      existing?.status === "invited" &&
      existing.expiresAt &&
      existing.expiresAt > new Date()
    ) {
      throw Object.assign(new Error("That person is already invited"), { status: 400 });
    }

    const previous = existing
      ? {
          status: existing.status,
          role: existing.role,
          userId: existing.userId,
          expiresAt: existing.expiresAt,
        }
      : null;
    const member = existing
      ? await existing.update({
          status: "invited",
          role: nextRole,
          userId: existing.userId || existingUser?.id || null,
          expiresAt,
        })
      : await CompanyMember.create({
          companyId,
          email: normalized,
          userId: existingUser?.id || null,
          role: nextRole,
          status: "invited",
          expiresAt,
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
      });
    } catch (error) {
      if (previous && existing) await existing.update(previous);
      else await member.destroy();
      throw error;
    }

    return {
      id: member.id,
      email: member.email,
      role: member.role,
      status: member.status,
      expiresAt: member.expiresAt ? member.expiresAt.toISOString() : null,
      emailSent,
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
    if (member.status === "invited") {
      await member.destroy();
      return { ok: true };
    }
    await member.update({ status: "removed", expiresAt: null });
    return { ok: true };
  }

  async accept(companyId: number, userId: number) {
    const user = await this.requireUser(userId);
    await this.claimInvites(userId, user.email);
    const member = await this.openInvite(companyId, userId);
    await member.update({ status: "active", expiresAt: null });
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
      include: [{ model: Company, as: "company", attributes: ["id", "name", "status"] }],
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
    };
  }
}

export default new CompanyService();
