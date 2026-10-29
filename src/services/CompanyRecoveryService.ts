import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import { CompanyRecoveryKey, MemberRecovery } from "../models/CompanyRecovery";
import User from "../models/User";
import E2EAccountService from "./E2EAccountService";

/**
 * Company admin recovery (E2E_DESIGN.md section 6, option 2), opt-in per company.
 *
 * Turning it on, the owner's browser makes a recovery key pair: the public key
 * is kept here, the private key sealed to each owner and admin. Each member's
 * browser then seals a copy of their user key to that public key. To reset a
 * member's master password, an owner's or admin's browser opens their copy of
 * the private key, then the member's user key, and locks it again with a
 * temporary master password. The server never holds anything it can open.
 *
 * Owners' and admins' browsers hand the private key to new owners and admins,
 * and replace the key pair when someone who held it is no longer one (members
 * then seal their user key again to the new public key).
 */

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SEALED = /^e2e1x\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,120}$/;

export class RecoveryError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const sealed = (value: unknown, name: string) => {
  const text = String(value || "");
  if (!SEALED.test(text)) throw new RecoveryError(`Bad ${name}.`);
  return text;
};

const managerRoles = ["owner", "admin"];

class CompanyRecoveryService {
  private async membership(companyId: number, userId: number) {
    return CompanyMember.findOne({ where: { companyId, userId, status: "active" } });
  }

  /** Active owners and admins, with their public keys (null without end-to-end). */
  private async managers(companyId: number) {
    const rows = await CompanyMember.findAll({
      where: { companyId, status: "active", role: { [Op.in]: managerRoles }, userId: { [Op.not]: null } },
      attributes: ["userId"],
    });
    const users = rows.length
      ? await User.findAll({
          where: { id: { [Op.in]: rows.map((row) => row.userId as number) } },
          attributes: ["id", "e2eEnabled", "publicKey"],
        })
      : [];
    return users.map((user) => ({ userId: user.id, publicKey: user.e2eEnabled && user.publicKey ? user.publicKey : null }));
  }

  private async activeCompany(companyId: number) {
    const company = await Company.findByPk(companyId);
    if (!company || company.status !== "active") throw new RecoveryError("Company not found.", 404);
    return company;
  }

  /** Whether it's on, and which members can be recovered (for owners and admins). */
  async status(companyId: number, userId: number) {
    const company = await this.activeCompany(companyId);
    const me = await this.membership(companyId, userId);
    if (!me) throw new RecoveryError("Company not found.", 404);
    const enabled = !!company.recoveryKeyVersion;
    const manager = managerRoles.includes(me.role);
    const enrolled = enabled
      ? await MemberRecovery.findAll({
          where: { companyId, keyVersion: company.recoveryKeyVersion as number },
          attributes: ["userId"],
        })
      : [];
    const holds = enabled
      ? !!(await CompanyRecoveryKey.count({
          where: { companyId, userId, keyVersion: company.recoveryKeyVersion as number },
        }))
      : false;
    return {
      enabled,
      // Members see this in their settings: their company can reset their master password.
      enrolledMe: enrolled.some((row) => row.userId === userId),
      ...(manager ? { recoverable: enrolled.map((row) => row.userId), canRecover: holds } : {}),
      // For the owner turning it on: who gets a copy of the private key.
      ...(me.role === "owner" && !enabled ? { managers: await this.managers(companyId) } : {}),
    };
  }

  /** The owner turns it on: a key pair made in their browser, the private key sealed to every owner and admin with keys. */
  async enable(companyId: number, userId: number, input: any) {
    const company = await this.activeCompany(companyId);
    const me = await this.membership(companyId, userId);
    if (me?.role !== "owner") throw new RecoveryError("Only the company's owner can change this.", 403);
    if (company.recoveryKeyVersion) throw new RecoveryError("Admin recovery is already on.", 409);
    const publicKey = String(input?.publicKey || "");
    if (!PUBLIC_KEY.test(publicKey)) throw new RecoveryError("Bad recovery key.");
    const keys = (Array.isArray(input?.keys) ? input.keys : []).map((key: any) => ({
      userId: Number(key?.userId),
      wrappedKey: sealed(key?.wrappedKey, "recovery key copy"),
    }));
    const managers = (await this.managers(companyId)).filter((item) => item.publicKey);
    if (!keys.some((key: { userId: number }) => key.userId === userId)) {
      throw new RecoveryError("Turn on end-to-end encryption first.", 409);
    }
    if (
      keys.some((key: { userId: number }) => !managers.some((item) => item.userId === key.userId)) ||
      !managers.every((item) => keys.some((key: { userId: number }) => key.userId === item.userId))
    ) {
      throw new RecoveryError("The key must go to exactly the owners and admins. Reload and try again.", 409);
    }
    await sequelize.transaction(async (transaction) => {
      await CompanyRecoveryKey.destroy({ where: { companyId }, transaction });
      await MemberRecovery.destroy({ where: { companyId }, transaction });
      for (const key of keys) {
        await CompanyRecoveryKey.create({ companyId, userId: key.userId, keyVersion: 1, wrappedKey: key.wrappedKey }, { transaction });
      }
      await company.update({ recoveryPublicKey: publicKey, recoveryKeyVersion: 1 }, { transaction });
    });
  }

  /** Off: every copy is deleted. */
  async disable(companyId: number, userId: number) {
    const company = await this.activeCompany(companyId);
    const me = await this.membership(companyId, userId);
    if (me?.role !== "owner") throw new RecoveryError("Only the company's owner can change this.", 403);
    await sequelize.transaction(async (transaction) => {
      await CompanyRecoveryKey.destroy({ where: { companyId }, transaction });
      await MemberRecovery.destroy({ where: { companyId }, transaction });
      await company.update({ recoveryPublicKey: null, recoveryKeyVersion: null }, { transaction });
    });
  }

  /**
   * Background work for this person's browser: seal their own user key for
   * companies that have it on; and, as an owner or admin holding the key,
   * give it to new owners and admins, or replace it after someone who held it
   * left that role.
   */
  async tasks(userId: number) {
    const user = await User.findByPk(userId, { attributes: ["id", "e2eEnabled"] });
    if (!user?.e2eEnabled) return { enroll: [], grant: [], rotate: [] };
    const memberships = await CompanyMember.findAll({ where: { userId, status: "active" } });
    const companies = memberships.length
      ? await Company.findAll({
          where: {
            id: { [Op.in]: memberships.map((row) => row.companyId) },
            status: "active",
            recoveryKeyVersion: { [Op.not]: null },
          },
        })
      : [];
    const enroll = [];
    const grant = [];
    const rotate = [];
    for (const company of companies) {
      const version = company.recoveryKeyVersion as number;
      const mine = await MemberRecovery.findOne({ where: { companyId: company.id, userId } });
      if (!mine || mine.keyVersion !== version) {
        enroll.push({ companyId: company.id, companyName: company.name, keyVersion: version, publicKey: company.recoveryPublicKey });
      }
      const role = memberships.find((row) => row.companyId === company.id)?.role;
      if (!role || !managerRoles.includes(role)) continue;
      const holders = await CompanyRecoveryKey.findAll({ where: { companyId: company.id } });
      const myCopy = holders.find((row) => row.userId === userId && row.keyVersion === version);
      if (!myCopy) continue;
      const managers = await this.managers(company.id);
      const stale = holders.some((row) => !managers.some((item) => item.userId === row.userId));
      const keyed = managers.filter((item) => item.publicKey);
      if (stale) {
        rotate.push({ companyId: company.id, keyVersion: version, managers: keyed });
        continue;
      }
      const missing = keyed.filter((item) => !holders.some((row) => row.userId === item.userId && row.keyVersion === version));
      if (missing.length) grant.push({ companyId: company.id, keyVersion: version, myKey: myCopy.wrappedKey, managers: missing });
    }
    return { enroll, grant, rotate };
  }

  /** A member's user key, sealed to the company's current recovery public key. */
  async enroll(userId: number, input: any) {
    const companyId = Number(input?.companyId);
    const company = await this.activeCompany(companyId);
    if (!(await this.membership(companyId, userId))) throw new RecoveryError("Company not found.", 404);
    if (Number(input?.keyVersion) !== company.recoveryKeyVersion) throw new RecoveryError("The recovery key changed. Try again.", 409);
    const sealedUserKey = sealed(input?.sealedUserKey, "recovery copy");
    await MemberRecovery.destroy({ where: { companyId, userId } });
    await MemberRecovery.create({ companyId, userId, keyVersion: company.recoveryKeyVersion as number, sealedUserKey });
  }

  /** Copies of the recovery private key for owners and admins who don't have one yet. */
  async grant(userId: number, input: any) {
    const companyId = Number(input?.companyId);
    const company = await this.activeCompany(companyId);
    const me = await this.membership(companyId, userId);
    if (!me || !managerRoles.includes(me.role)) throw new RecoveryError("Only owners and admins can do this.", 403);
    if (Number(input?.keyVersion) !== company.recoveryKeyVersion) throw new RecoveryError("The recovery key changed. Try again.", 409);
    const managers = await this.managers(companyId);
    for (const key of Array.isArray(input?.keys) ? input.keys : []) {
      const target = Number(key?.userId);
      if (!managers.some((item) => item.userId === target && item.publicKey)) continue;
      await CompanyRecoveryKey.destroy({ where: { companyId, userId: target } });
      await CompanyRecoveryKey.create({
        companyId,
        userId: target,
        keyVersion: company.recoveryKeyVersion as number,
        wrappedKey: sealed(key?.wrappedKey, "recovery key copy"),
      });
    }
  }

  /**
   * A new recovery key pair, after someone who held the old one stopped being
   * an owner or admin. Members' copies under the old key are deleted; their
   * browsers seal their user key again to the new public key.
   */
  async rotate(userId: number, input: any) {
    const companyId = Number(input?.companyId);
    const company = await this.activeCompany(companyId);
    const me = await this.membership(companyId, userId);
    if (!me || !managerRoles.includes(me.role)) throw new RecoveryError("Only owners and admins can do this.", 403);
    const version = company.recoveryKeyVersion as number;
    if (!version || Number(input?.keyVersion) !== version + 1) throw new RecoveryError("The recovery key changed. Try again.", 409);
    const publicKey = String(input?.publicKey || "");
    if (!PUBLIC_KEY.test(publicKey)) throw new RecoveryError("Bad recovery key.");
    const keyed = (await this.managers(companyId)).filter((item) => item.publicKey);
    const keys = (Array.isArray(input?.keys) ? input.keys : []).map((key: any) => ({
      userId: Number(key?.userId),
      wrappedKey: sealed(key?.wrappedKey, "recovery key copy"),
    }));
    if (!keyed.every((item) => keys.some((key: { userId: number }) => key.userId === item.userId))) {
      throw new RecoveryError("The new key must go to every owner and admin. Reload and try again.", 409);
    }
    await sequelize.transaction(async (transaction) => {
      await CompanyRecoveryKey.destroy({ where: { companyId }, transaction });
      await MemberRecovery.destroy({ where: { companyId }, transaction });
      for (const key of keys.filter((key: { userId: number }) => keyed.some((item) => item.userId === key.userId))) {
        await CompanyRecoveryKey.create({ companyId, userId: key.userId, keyVersion: version + 1, wrappedKey: key.wrappedKey }, { transaction });
      }
      await company.update({ recoveryPublicKey: publicKey, recoveryKeyVersion: version + 1 }, { transaction });
    });
  }

  /** Who may reset whom: owners anyone but themselves; admins only members. */
  private async assertCanReset(companyId: number, adminId: number, memberUserId: number) {
    const company = await this.activeCompany(companyId);
    if (!company.recoveryKeyVersion) throw new RecoveryError("Admin recovery is off for this company.", 409);
    const admin = await this.membership(companyId, adminId);
    const member = await this.membership(companyId, memberUserId);
    if (!admin || !member || adminId === memberUserId) throw new RecoveryError("You can't reset this person's master password.", 403);
    if (admin.role === "member" || (admin.role === "admin" && member.role !== "member")) {
      throw new RecoveryError("You can't reset this person's master password.", 403);
    }
    return company;
  }

  /** What an owner's or admin's browser needs to reset a member: their copy of the private key, and the member's sealed user key. */
  async memberKeys(companyId: number, adminId: number, memberUserId: number) {
    const company = await this.assertCanReset(companyId, adminId, memberUserId);
    const version = company.recoveryKeyVersion as number;
    const myKey = await CompanyRecoveryKey.findOne({ where: { companyId, userId: adminId, keyVersion: version } });
    const copy = await MemberRecovery.findOne({ where: { companyId, userId: memberUserId, keyVersion: version } });
    if (!myKey) throw new RecoveryError("You don't hold the company's recovery key yet. Another owner or admin gives it to you when they open 2keevo.", 409);
    if (!copy) throw new RecoveryError("This person hasn't opened 2keevo since admin recovery was turned on, so it can't be used for them yet.", 409);
    return { keyVersion: version, publicKey: company.recoveryPublicKey, myKey: myKey.wrappedKey, sealedUserKey: copy.sealedUserKey };
  }

  /** Set the temporary master password made in the admin's browser. */
  async reset(companyId: number, adminId: number, memberUserId: number, input: any) {
    await this.assertCanReset(companyId, adminId, memberUserId);
    const member = await User.findByPk(memberUserId);
    if (!member) throw new RecoveryError("Person not found.", 404);
    await E2EAccountService.resetByCompany(member, input);
    return member;
  }
}

export default new CompanyRecoveryService();
