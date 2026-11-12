import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Collection from "../models/Collection";
import CollectionKey from "../models/CollectionKey";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import { CompanyRecoveryKey, RecoveryCustodian, RecoveryRequest, VaultRecoveryKey } from "../models/CompanyRecovery";
import User from "../models/User";
import { notifyRecovery } from "./recoveryNotify";

/**
 * Vault recovery (ADR-001 option A; E2E_DESIGN.md section 6).
 *
 * The owner's browser makes the company recovery key pair: the public key is
 * kept here, the private key sealed to each **custodian** (the owner and at
 * least one more owner or admin). Each company collection key is also sealed
 * to the public key ("recovery copy"), by any browser holding that key. A
 * recovery request (VaultRecoveryService) lets a custodian's browser open one
 * collection key and hand it to a person, after a second person's approval and
 * a waiting period. Members' user keys are never sealed to the company, so
 * nothing here can open anyone's personal items. The server never holds
 * anything it can open.
 */

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SEALED = /^e2e1x\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,120}$/;
export const WAIT_CHOICES = [0, 24, 48, 72];
const MAX_CONTINUITY_ITEMS = 500;

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

const waitHours = (value: unknown) => {
  const hours = Number(value);
  if (!WAIT_CHOICES.includes(hours)) {
    throw new RecoveryError("Choose a waiting period of 0, 24, 48 or 72 hours.");
  }
  return hours;
};

const idList = (value: unknown) =>
  [...new Set((Array.isArray(value) ? value : []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);

class CompanyRecoveryService {
  private async membership(companyId: number, userId: number) {
    return CompanyMember.findOne({ where: { companyId, userId, status: "active" } });
  }

  private async activeCompany(companyId: number) {
    const company = await Company.findByPk(companyId);
    if (!company || company.status !== "active") throw new RecoveryError("Company not found.", 404);
    return company;
  }

  /** Active owners and admins with end-to-end encryption on: who may be a custodian. */
  private async keyedManagers(companyId: number) {
    const rows = await CompanyMember.findAll({
      where: { companyId, status: "active", role: { [Op.in]: managerRoles }, userId: { [Op.not]: null } },
      attributes: ["userId"],
    });
    const users = rows.length
      ? await User.findAll({
          where: { id: { [Op.in]: rows.map((row) => row.userId as number) } },
          attributes: ["id", "email", "e2eEnabled", "publicKey"],
        })
      : [];
    return users
      .filter((user) => user.e2eEnabled && user.publicKey)
      .map((user) => ({ userId: user.id, email: user.email, publicKey: user.publicKey as string }));
  }

  /** The named custodians who are still active owners or admins. */
  async activeCustodianIds(companyId: number): Promise<number[]> {
    const rows = await RecoveryCustodian.findAll({ where: { companyId }, attributes: ["userId"] });
    if (!rows.length) return [];
    const members = await CompanyMember.findAll({
      where: {
        companyId,
        status: "active",
        role: { [Op.in]: managerRoles },
        userId: { [Op.in]: rows.map((row) => row.userId) },
      },
      attributes: ["userId"],
    });
    return members.map((member) => member.userId as number);
  }

  /** Custodians who can receive a copy: active owners/admins with keys. */
  private async keyedCustodians(companyId: number) {
    const ids = await this.activeCustodianIds(companyId);
    return (await this.keyedManagers(companyId))
      .filter((item) => ids.includes(item.userId))
      .map((item) => ({ userId: item.userId, publicKey: item.publicKey }));
  }

  /** A custodian set the owner chose: two or more owners/admins with end-to-end on. */
  private async checkCustodians(companyId: number, custodianIds: number[]) {
    if (custodianIds.length < 2) {
      throw new RecoveryError("Name a second custodian (an owner or admin with end-to-end encryption on).", 409);
    }
    const keyed = await this.keyedManagers(companyId);
    if (!custodianIds.every((id) => keyed.some((item) => item.userId === id))) {
      throw new RecoveryError("Custodians must be owners or admins with end-to-end encryption on.", 409);
    }
  }

  private async requireOwner(companyId: number, userId: number) {
    const me = await this.membership(companyId, userId);
    if (me?.role !== "owner") throw new RecoveryError("Only the company's owner can change this.", 403);
  }

  /** Who holds a copy of the current recovery key. */
  private async currentHolderIds(companyId: number, keyVersion: number) {
    const rows = await CompanyRecoveryKey.findAll({ where: { companyId, keyVersion }, attributes: ["userId"] });
    return rows.map((row) => row.userId);
  }

  /**
   * Vaults a request could recover now: their copy is of the vault's current key,
   * sealed to a recovery key (current or earlier) an active custodian holds.
   */
  private async recoverableVaultIds(companyId: number, custodianIds: number[]) {
    const copies = await VaultRecoveryKey.findAll({ where: { companyId } });
    if (!copies.length || !custodianIds.length) return [];
    const collections = await Collection.findAll({
      where: { id: { [Op.in]: copies.map((copy) => copy.collectionId) } },
      attributes: ["id", "e2eKeyVersion"],
    });
    const held = new Set(
      (await CompanyRecoveryKey.findAll({ where: { companyId, userId: { [Op.in]: custodianIds } }, attributes: ["keyVersion"] })).map(
        (row) => row.keyVersion
      )
    );
    return copies
      .filter((copy) => {
        const collection = collections.find((item) => item.id === copy.collectionId);
        return !!collection && collection.e2eKeyVersion === copy.keyVersion && held.has(copy.recoveryKeyVersion);
      })
      .map((copy) => copy.collectionId)
      .sort((a, b) => a - b);
  }

  private async emails(ids: number[]) {
    if (!ids.length) return "";
    const people = await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "email"] });
    return people.map((person) => person.email).join(", ");
  }

  private async requireCustodian(companyId: number, userId: number) {
    if (!(await this.activeCustodianIds(companyId)).includes(userId)) {
      throw new RecoveryError("Only the company's recovery custodians can do this.", 403);
    }
  }

  /** Whether it's on, the waiting period and custodians; the owner also gets who could be one. */
  async status(companyId: number, userId: number) {
    const company = await this.activeCompany(companyId);
    const me = await this.membership(companyId, userId);
    if (!me) throw new RecoveryError("Company not found.", 404);
    const enabled = !!company.recoveryKeyVersion;
    const custodianIds = enabled ? await this.activeCustodianIds(companyId) : [];
    const people = custodianIds.length
      ? await User.findAll({ where: { id: { [Op.in]: custodianIds } }, attributes: ["id", "email"] })
      : [];
    const holders = enabled ? await this.currentHolderIds(companyId, company.recoveryKeyVersion as number) : [];
    // The details below are for whoever manages or runs recoveries, not every member.
    const involved = enabled && (managerRoles.includes(me.role) || custodianIds.includes(userId));
    // Named custodians who are no longer active owners/admins.
    const named = involved ? (await RecoveryCustodian.findAll({ where: { companyId }, attributes: ["userId"] })).map((row) => row.userId) : [];
    const inactiveIds = named.filter((id) => !custodianIds.includes(id));
    const inactive = inactiveIds.length
      ? await User.findAll({ where: { id: { [Op.in]: inactiveIds } }, attributes: ["id", "email"] })
      : [];
    return {
      inactiveCustodians: inactive.map((person) => ({ userId: person.id, email: person.email })),
      recoverableVaultIds: involved ? await this.recoverableVaultIds(companyId, custodianIds) : [],
      enabled,
      waitHours: company.recoveryWaitHours ?? 24,
      custodians: people.map((person) => ({ userId: person.id, email: person.email })),
      iAmCustodian: custodianIds.includes(userId),
      holdsKey: holders.includes(userId),
      // No active custodian holds the key: nobody can recover or hand it on. Turning it off and on again fixes it.
      keyLost: enabled && !custodianIds.some((id) => holders.includes(id)),
      ...(me.role === "owner" ? { candidates: await this.keyedManagers(companyId) } : {}),
    };
  }

  /**
   * The owner turns it on: a key pair made in their browser, the private key
   * sealed to each custodian (the owner and at least one more owner or admin).
   */
  async enable(companyId: number, userId: number, input: any) {
    const company = await this.activeCompany(companyId);
    await this.requireOwner(companyId, userId);
    if (company.recoveryKeyVersion) throw new RecoveryError("Vault recovery is already on.", 409);
    const publicKey = String(input?.publicKey || "");
    if (!PUBLIC_KEY.test(publicKey)) throw new RecoveryError("Bad recovery key.");
    const hours = waitHours(input?.waitHours ?? 24);
    const custodianIds = idList(input?.custodianIds);
    const keyed = await this.keyedManagers(companyId);
    if (!keyed.some((item) => item.userId === userId)) {
      throw new RecoveryError("Turn on end-to-end encryption first.", 409);
    }
    if (!custodianIds.includes(userId)) throw new RecoveryError("You must be one of the custodians.");
    await this.checkCustodians(companyId, custodianIds);
    const keys = (Array.isArray(input?.keys) ? input.keys : []).map((key: any) => ({
      userId: Number(key?.userId),
      wrappedKey: sealed(key?.wrappedKey, "recovery key copy"),
    }));
    if (
      keys.length !== custodianIds.length ||
      !custodianIds.every((id) => keys.some((key: { userId: number }) => key.userId === id))
    ) {
      throw new RecoveryError("The key must go to exactly the custodians. Reload and try again.", 409);
    }
    await sequelize.transaction(async (transaction) => {
      await CompanyRecoveryKey.destroy({ where: { companyId }, transaction });
      await RecoveryCustodian.destroy({ where: { companyId }, transaction });
      await VaultRecoveryKey.destroy({ where: { companyId }, transaction });
      for (const id of custodianIds) {
        await RecoveryCustodian.create({ companyId, userId: id, addedBy: userId }, { transaction });
      }
      for (const key of keys) {
        await CompanyRecoveryKey.create({ companyId, userId: key.userId, keyVersion: 1, wrappedKey: key.wrappedKey }, { transaction });
      }
      await company.update({ recoveryPublicKey: publicKey, recoveryKeyVersion: 1, recoveryWaitHours: hours }, { transaction });
    });
    await notifyRecovery(
      companyId,
      `Vault recovery was turned on in ${company.name}. Custodians: ${await this.emails(custodianIds)}. Waiting period: ${hours} h.`,
      custodianIds
    );
    return { custodianIds, waitHours: hours };
  }

  /** Off: every copy is deleted and open requests are cancelled. */
  async disable(companyId: number, userId: number) {
    const company = await this.activeCompany(companyId);
    await this.requireOwner(companyId, userId);
    const custodianIds = await this.activeCustodianIds(companyId);
    await sequelize.transaction(async (transaction) => {
      await CompanyRecoveryKey.destroy({ where: { companyId }, transaction });
      await RecoveryCustodian.destroy({ where: { companyId }, transaction });
      await VaultRecoveryKey.destroy({ where: { companyId }, transaction });
      await RecoveryRequest.update(
        { status: "cancelled", cancelledBy: userId },
        { where: { companyId, status: { [Op.in]: ["pending", "approved"] } }, transaction }
      );
      await company.update({ recoveryPublicKey: null, recoveryKeyVersion: null }, { transaction });
    });
    await notifyRecovery(
      companyId,
      `Vault recovery was turned off in ${company.name}. Recovery copies were deleted and open requests cancelled.`,
      custodianIds
    );
  }

  /**
   * The owner changes the waiting period or the custodians. Added custodians
   * get a copy from another custodian's browser (grant task); a removed one
   * keeps their old copy until the recovery key is replaced (rotate task).
   */
  async updateSettings(companyId: number, userId: number, input: any) {
    const company = await this.activeCompany(companyId);
    await this.requireOwner(companyId, userId);
    if (!company.recoveryKeyVersion) throw new RecoveryError("Vault recovery is off.", 409);
    const result: { waitHours?: number; added?: number[]; removed?: number[] } = {};
    // Everything is checked before anything is written.
    const hours = input?.waitHours !== undefined ? waitHours(input.waitHours) : undefined;
    const next = input?.custodianIds !== undefined ? idList(input.custodianIds) : undefined;
    if (next) {
      await this.checkCustodians(companyId, next);
      // Someone in the new set must hold the key now, to hand it on; otherwise it's lost.
      const holders = await this.currentHolderIds(companyId, company.recoveryKeyVersion);
      if (!next.some((id) => holders.includes(id))) {
        throw new RecoveryError("Keep at least one custodian who holds the recovery key now.", 409);
      }
    }
    if (hours !== undefined) {
      result.waitHours = hours;
      await company.update({ recoveryWaitHours: hours });
    }
    if (next) {
      const current = (await RecoveryCustodian.findAll({ where: { companyId }, attributes: ["userId"] })).map((row) => row.userId);
      result.added = next.filter((id) => !current.includes(id));
      result.removed = current.filter((id) => !next.includes(id));
      await sequelize.transaction(async (transaction) => {
        if (result.removed?.length) {
          await RecoveryCustodian.destroy({ where: { companyId, userId: { [Op.in]: result.removed } }, transaction });
        }
        for (const id of result.added || []) {
          await RecoveryCustodian.create({ companyId, userId: id, addedBy: userId }, { transaction });
        }
      });
    }
    // Told to everyone involved, including anyone removed as custodian.
    const custodianIds = await this.activeCustodianIds(companyId);
    const parts: string[] = [];
    if (result.added?.length || result.removed?.length) {
      parts.push(`Custodians are now ${await this.emails(custodianIds)}.`);
      if (result.removed?.length) parts.push(`Removed: ${await this.emails(result.removed)}.`);
    }
    if (result.waitHours !== undefined) parts.push(`Waiting period: ${result.waitHours} h.`);
    if (parts.length) {
      await notifyRecovery(companyId, `Vault recovery settings changed in ${company.name}. ${parts.join(" ")}`, [
        ...custodianIds,
        ...(result.removed || []),
      ]);
    }
    return result;
  }

  /**
   * Background work for this person's browser, per company with recovery on:
   * - grant / rotate (custodians holding the current copy): give the recovery
   *   key to custodians without one, or replace it after a holder stopped being
   *   a custodian;
   * - continuity (anyone holding a vault's current key): seal that key to the
   *   recovery public key when the copy is missing or out of date.
   */
  async tasks(userId: number) {
    const user = await User.findByPk(userId, { attributes: ["id", "e2eEnabled"] });
    if (!user?.e2eEnabled) return { grant: [], rotate: [], continuity: [] };
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
    const grant = [];
    const rotate = [];
    const continuity = [];
    for (const company of companies) {
      const version = company.recoveryKeyVersion as number;
      const custodianIds = await this.activeCustodianIds(company.id);
      if (custodianIds.includes(userId)) {
        const holders = await CompanyRecoveryKey.findAll({ where: { companyId: company.id } });
        const myCopy = holders.find((row) => row.userId === userId && row.keyVersion === version);
        if (myCopy) {
          const keyed = await this.keyedCustodians(company.id);
          if (holders.some((row) => !custodianIds.includes(row.userId))) {
            rotate.push({ companyId: company.id, keyVersion: version, custodians: keyed });
          } else {
            const missing = keyed.filter(
              (item) => !holders.some((row) => row.userId === item.userId && row.keyVersion === version)
            );
            if (missing.length) grant.push({ companyId: company.id, keyVersion: version, myKey: myCopy.wrappedKey, custodians: missing });
          }
        }
      }
      const collections = await Collection.findAll({
        where: { companyId: company.id, e2eKeyVersion: { [Op.not]: null } },
        attributes: ["id", "e2eKeyVersion"],
      });
      if (!collections.length) continue;
      const copies = await VaultRecoveryKey.findAll({ where: { companyId: company.id } });
      const needed = collections.filter((collection) => {
        const copy = copies.find((row) => row.collectionId === collection.id);
        return !copy || copy.keyVersion !== collection.e2eKeyVersion || copy.recoveryKeyVersion !== version;
      });
      if (!needed.length) continue;
      const myKeys = await CollectionKey.findAll({
        where: { userId, collectionId: { [Op.in]: needed.map((collection) => collection.id) } },
      });
      for (const collection of needed) {
        const mine = myKeys.find((row) => row.collectionId === collection.id && row.keyVersion === collection.e2eKeyVersion);
        if (!mine) continue;
        continuity.push({
          companyId: company.id,
          recoveryKeyVersion: version,
          recoveryPublicKey: company.recoveryPublicKey as string,
          collectionId: collection.id,
          keyVersion: collection.e2eKeyVersion as number,
          myKey: mine.wrappedKey,
        });
      }
    }
    return { grant, rotate, continuity };
  }

  /**
   * Recovery copies of vault keys, made in a key holder's browser. Each is kept
   * only if it is of the vault's current key, sealed to the company's current
   * recovery key, and the sender holds that vault key.
   */
  async saveContinuity(userId: number, input: any) {
    const items = (Array.isArray(input?.items) ? input.items : []).slice(0, MAX_CONTINUITY_ITEMS);
    let saved = 0;
    for (const item of items) {
      const collectionId = Number(item?.collectionId);
      const collection = Number.isInteger(collectionId) ? await Collection.findByPk(collectionId) : null;
      if (!collection?.companyId || collection.e2eKeyVersion !== Number(item?.keyVersion)) continue;
      const company = await Company.findByPk(collection.companyId);
      if (!company || company.status !== "active" || !company.recoveryKeyVersion) continue;
      if (company.recoveryKeyVersion !== Number(item?.recoveryKeyVersion)) continue;
      if (!(await this.membership(company.id, userId))) continue;
      const holds = await CollectionKey.count({ where: { collectionId, userId, keyVersion: collection.e2eKeyVersion } });
      if (!holds) continue;
      const wrappedKey = String(item?.wrappedKey || "");
      if (!SEALED.test(wrappedKey)) continue;
      // Only a missing or out-of-date copy is replaced: a current one can't be swapped for a bad one.
      const existing = await VaultRecoveryKey.findOne({ where: { collectionId } });
      if (existing && existing.keyVersion === collection.e2eKeyVersion && existing.recoveryKeyVersion === company.recoveryKeyVersion) {
        continue;
      }
      // Each copy on its own (a race on one vault must not fail the others in the batch).
      try {
        await sequelize.transaction(async (transaction) => {
          await VaultRecoveryKey.destroy({ where: { collectionId }, transaction });
          await VaultRecoveryKey.create(
            {
              companyId: company.id,
              collectionId,
              keyVersion: collection.e2eKeyVersion as number,
              recoveryKeyVersion: company.recoveryKeyVersion as number,
              recoveryPublicKey: company.recoveryPublicKey,
              wrappedKey,
            },
            { transaction }
          );
        });
        saved += 1;
      } catch (error) {
        console.error(`Could not save the recovery copy of vault ${collectionId}:`, (error as Error)?.message || error);
      }
    }
    return { saved };
  }

  /** Copies of the recovery private key for custodians who don't have one yet. */
  async grant(userId: number, input: any) {
    const companyId = Number(input?.companyId);
    const company = await this.activeCompany(companyId);
    await this.requireCustodian(companyId, userId);
    if (Number(input?.keyVersion) !== company.recoveryKeyVersion) throw new RecoveryError("The recovery key changed. Try again.", 409);
    const keyed = await this.keyedCustodians(companyId);
    const holders = await this.currentHolderIds(companyId, company.recoveryKeyVersion as number);
    for (const key of Array.isArray(input?.keys) ? input.keys : []) {
      const target = Number(key?.userId);
      // Only custodians without a current copy: nobody can overwrite another custodian's copy.
      if (!keyed.some((item) => item.userId === target) || holders.includes(target)) continue;
      // Their copies of earlier keys stay (vaults nobody holds may still need them).
      await CompanyRecoveryKey.destroy({ where: { companyId, userId: target, keyVersion: company.recoveryKeyVersion as number } });
      await CompanyRecoveryKey.create({
        companyId,
        userId: target,
        keyVersion: company.recoveryKeyVersion as number,
        wrappedKey: sealed(key?.wrappedKey, "recovery key copy"),
      });
    }
  }

  /**
   * A new recovery key pair, after someone who held the old one stopped being a
   * custodian. The vault recovery copies sealed to the old key are deleted; key
   * holders' browsers make new ones (continuity task).
   */
  async rotate(userId: number, input: any) {
    const companyId = Number(input?.companyId);
    const company = await this.activeCompany(companyId);
    await this.requireCustodian(companyId, userId);
    const version = company.recoveryKeyVersion as number;
    if (!version || Number(input?.keyVersion) !== version + 1) throw new RecoveryError("The recovery key changed. Try again.", 409);
    // Only when it's due (someone who isn't a custodian still holds a copy), by a custodian holding the current copy:
    // every replacement deletes the vault recovery copies until key holders make new ones.
    const custodianIds = await this.activeCustodianIds(companyId);
    const holderRows = await CompanyRecoveryKey.findAll({ where: { companyId }, attributes: ["userId", "keyVersion"] });
    const mine = holderRows.some((row) => row.userId === userId && row.keyVersion === version);
    if (!mine || !holderRows.some((row) => !custodianIds.includes(row.userId))) {
      throw new RecoveryError("The recovery key doesn't need replacing.", 409);
    }
    const publicKey = String(input?.publicKey || "");
    if (!PUBLIC_KEY.test(publicKey)) throw new RecoveryError("Bad recovery key.");
    const keyed = await this.keyedCustodians(companyId);
    const keys = (Array.isArray(input?.keys) ? input.keys : []).map((key: any) => ({
      userId: Number(key?.userId),
      wrappedKey: sealed(key?.wrappedKey, "recovery key copy"),
    }));
    if (!keyed.every((item) => keys.some((key: { userId: number }) => key.userId === item.userId))) {
      throw new RecoveryError("The new key must go to every custodian. Reload and try again.", 409);
    }
    await sequelize.transaction(async (transaction) => {
      // First, and only from the version this was based on: of two rotations at once, one wins.
      const [changed] = await Company.update(
        { recoveryPublicKey: publicKey, recoveryKeyVersion: version + 1 },
        { where: { id: companyId, recoveryKeyVersion: version }, transaction }
      );
      if (!changed) throw new RecoveryError("The recovery key changed. Try again.", 409);
      // Whoever stopped being a custodian loses every copy, and their custodian entry (being made
      // admin again doesn't make them one). Remaining custodians keep their copies of earlier keys,
      // and vault recovery copies stay: a vault nobody holds any more keeps the copy sealed to an
      // earlier key (key holders re-make the others for the new key).
      // Read again now: a custodian the owner added meanwhile isn't dropped by this older view.
      const stillCustodians = await this.activeCustodianIds(companyId);
      await CompanyRecoveryKey.destroy({ where: { companyId, userId: { [Op.notIn]: stillCustodians } }, transaction });
      await RecoveryCustodian.destroy({ where: { companyId, userId: { [Op.notIn]: stillCustodians } }, transaction });
      for (const key of keys.filter((key: { userId: number }) => keyed.some((item) => item.userId === key.userId))) {
        await CompanyRecoveryKey.create({ companyId, userId: key.userId, keyVersion: version + 1, wrappedKey: key.wrappedKey }, { transaction });
      }
    });
  }
}

export default new CompanyRecoveryService();
