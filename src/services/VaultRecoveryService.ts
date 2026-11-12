import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Collection from "../models/Collection";
import CollectionKey from "../models/CollectionKey";
import CollectionShare from "../models/CollectionShare";
import ItemKey from "../models/ItemKey";
import Note from "../models/Note";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import { CompanyRecoveryKey, RecoveryRequest, VaultRecoveryKey } from "../models/CompanyRecovery";
import User from "../models/User";
import CollectionService from "./CollectionService";
import CompanyRecoveryService, { RecoveryError } from "./CompanyRecoveryService";
import { notifyRecovery } from "./recoveryNotify";

/**
 * Recovery requests (ADR-001 option A): give one person a company vault's key
 * when nobody who holds it can. A request names the vault, the person, the
 * access and a reason; a second person (a custodian other than the requester)
 * approves it; after the company's waiting period a custodian's browser opens
 * the vault's recovery copy and seals the key to the person. The approval is a
 * check by another person, not extra encryption. Custodians and owners are
 * told at every step; the person is told when it's done.
 */

const SEALED = /^e2e1x\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,120}$/;
const OPEN = ["pending", "approved"];
const HOUR_MS = 60 * 60 * 1000;
const managerRoles = ["owner", "admin"];

const isReady = (request: RecoveryRequest, now = new Date()) =>
  request.status === "approved" && request.availableAt.getTime() <= now.getTime();

class VaultRecoveryService {
  private async company(companyId: number) {
    const company = await Company.findByPk(companyId);
    if (!company || company.status !== "active") throw new RecoveryError("Company not found.", 404);
    if (!company.recoveryKeyVersion) throw new RecoveryError("Vault recovery is off for this company.", 409);
    return company;
  }

  private async membership(companyId: number, userId: number) {
    return CompanyMember.findOne({ where: { companyId, userId, status: "active" } });
  }

  private async request(companyId: number, requestId: number) {
    if (!Number.isInteger(requestId) || requestId <= 0) throw new RecoveryError("Request not found.", 404);
    const request = await RecoveryRequest.findOne({ where: { id: requestId, companyId } });
    if (!request) throw new RecoveryError("Request not found.", 404);
    return request;
  }

  /** Approving or completing needs the vault and the person to still exist (deleting them keeps the request as history). */
  private requireLive(request: RecoveryRequest) {
    if (!request.collectionId || !request.granteeUserId) {
      throw new RecoveryError("The vault or the person in this request was deleted. Cancel it.", 409);
    }
  }

  /** The person who gets the key: an active member with end-to-end encryption on. */
  private async grantee(companyId: number, userId: number) {
    const member = await this.membership(companyId, userId);
    const user = member ? await User.findByPk(userId, { attributes: ["id", "email", "e2eEnabled", "publicKey"] }) : null;
    if (!user?.e2eEnabled || !user.publicKey) return null;
    return user;
  }

  /** Every custodian and owner, and anyone extra (the grantee): in the app and by email. */
  private async notify(companyId: number, message: string, extra: number[] = []) {
    await notifyRecovery(companyId, message, [...(await CompanyRecoveryService.activeCustodianIds(companyId)), ...extra]);
  }

  private async names(collectionId: number | null, granteeUserId: number | null) {
    const grantee = granteeUserId ? await User.findByPk(granteeUserId, { attributes: ["id", "email"] }) : null;
    return {
      who: grantee?.email || (granteeUserId ? "a member" : "a deleted person"),
      vault: collectionId ? `vault #${collectionId}` : "a deleted vault",
    };
  }

  /** Past and open requests; readable also after recovery was turned off (history). */
  async list(companyId: number, userId: number) {
    const company = await Company.findByPk(companyId);
    if (!company || company.status !== "active") throw new RecoveryError("Company not found.", 404);
    const me = await this.membership(companyId, userId);
    const custodian = (await CompanyRecoveryService.activeCustodianIds(companyId)).includes(userId);
    if (!custodian && !(me && managerRoles.includes(me.role))) throw new RecoveryError("Only owners, admins and custodians can see this.", 403);
    const rows = await RecoveryRequest.findAll({ where: { companyId }, order: [["id", "DESC"]] });
    const granteeIds = rows.map((row) => row.granteeUserId).filter((id): id is number => !!id);
    const people = granteeIds.length
      ? await User.findAll({ where: { id: { [Op.in]: granteeIds } }, attributes: ["id", "email"] })
      : [];
    const now = new Date();
    return rows.map((row) => ({
      id: row.id,
      collectionId: row.collectionId,
      granteeUserId: row.granteeUserId,
      // The person's account (or the vault) may have been deleted since: the request stays as history.
      granteeEmail: people.find((person) => person.id === row.granteeUserId)?.email || "(deleted)",
      permission: row.permission,
      reason: row.reason,
      status: row.status,
      ready: isReady(row, now),
      requestedBy: row.requestedBy ?? null,
      approvedBy: row.approvedBy ?? null,
      availableAt: row.availableAt,
      createdAt: row.createdAt,
      completedAt: row.completedAt ?? null,
    }));
  }

  async create(companyId: number, userId: number, input: any) {
    const company = await this.company(companyId);
    const me = await this.membership(companyId, userId);
    if (!me || !managerRoles.includes(me.role)) throw new RecoveryError("Only owners and admins can ask for a recovery.", 403);
    const reason = String(input?.reason || "").trim();
    if (reason.length < 3 || reason.length > 500) throw new RecoveryError("Give a reason (3 to 500 characters).");
    const permission = input?.permission === "edit" ? "edit" : input?.permission === "view" ? "view" : null;
    if (!permission) throw new RecoveryError("Choose view or edit access.");
    const collectionId = Number(input?.collectionId);
    const collection = Number.isInteger(collectionId) ? await Collection.findByPk(collectionId) : null;
    if (!collection || collection.companyId !== companyId) throw new RecoveryError("Vault not found.", 404);
    // A copy of the vault's current key, sealed to a recovery key (current or earlier) that a custodian still holds.
    const copy = await VaultRecoveryKey.findOne({ where: { collectionId } });
    const custodianIds = await CompanyRecoveryService.activeCustodianIds(companyId);
    const openable =
      !!copy &&
      copy.keyVersion === collection.e2eKeyVersion &&
      (await CompanyRecoveryKey.count({
        where: { companyId, keyVersion: copy.recoveryKeyVersion, userId: { [Op.in]: custodianIds } },
      })) > 0;
    if (!openable) throw new RecoveryError("This vault has no recovery copy yet.", 409);
    const granteeUserId = Number(input?.granteeUserId);
    if (!(await this.grantee(companyId, granteeUserId))) {
      throw new RecoveryError("That person must be an active member with end-to-end encryption on.", 409);
    }
    const open = await RecoveryRequest.findOne({
      where: { companyId, collectionId, granteeUserId, status: { [Op.in]: OPEN } },
    });
    if (open) throw new RecoveryError("There is already an open request for this vault and person.", 409);
    const request = await RecoveryRequest.create({
      companyId,
      collectionId,
      granteeUserId,
      permission,
      reason,
      status: "pending",
      requestedBy: userId,
      availableAt: new Date(Date.now() + (company.recoveryWaitHours ?? 24) * HOUR_MS),
    });
    const { who, vault } = await this.names(collectionId, granteeUserId);
    await this.notify(
      companyId,
      `Vault recovery requested in ${company.name}: give ${who} ${permission} access to ${vault}. A custodian other than the requester must approve it.`
    );
    return request;
  }

  async approve(companyId: number, userId: number, requestId: number) {
    const company = await this.company(companyId);
    const request = await this.request(companyId, requestId);
    if (!(await CompanyRecoveryService.activeCustodianIds(companyId)).includes(userId)) {
      throw new RecoveryError("Only the company's recovery custodians can approve.", 403);
    }
    if (request.requestedBy === userId) throw new RecoveryError("Someone else must approve this.", 403);
    this.requireLive(request);
    // The waiting period runs from the approval, so there is always time to cancel an approved request.
    const approvedAt = new Date();
    const changes = {
      status: "approved" as const,
      approvedBy: userId,
      approvedAt,
      availableAt: new Date(approvedAt.getTime() + (company.recoveryWaitHours ?? 24) * HOUR_MS),
    };
    // Only from pending: a cancel that landed meanwhile stays.
    const [changed] = await RecoveryRequest.update(changes, { where: { id: request.id, companyId, status: "pending" } });
    if (!changed) throw new RecoveryError("This request isn't waiting for approval.", 409);
    Object.assign(request, changes);
    const { who, vault } = await this.names(request.collectionId, request.granteeUserId);
    await this.notify(
      companyId,
      `Vault recovery approved in ${company.name} for ${who} (${vault}). It can run from ${request.availableAt.toISOString()}.`,
      [request.requestedBy ?? 0]
    );
    return request;
  }

  async cancel(companyId: number, userId: number, requestId: number) {
    const company = await this.company(companyId);
    const request = await this.request(companyId, requestId);
    const me = await this.membership(companyId, userId);
    const custodian = (await CompanyRecoveryService.activeCustodianIds(companyId)).includes(userId);
    if (request.requestedBy !== userId && !custodian && me?.role !== "owner") {
      throw new RecoveryError("You can't cancel this request.", 403);
    }
    // Only while open: a completion that landed meanwhile stays on record.
    const [changed] = await RecoveryRequest.update(
      { status: "cancelled", cancelledBy: userId },
      { where: { id: request.id, companyId, status: { [Op.in]: OPEN } } }
    );
    if (!changed) throw new RecoveryError("This request is already closed.", 409);
    Object.assign(request, { status: "cancelled", cancelledBy: userId });
    const { who, vault } = await this.names(request.collectionId, request.granteeUserId);
    await this.notify(companyId, `Vault recovery cancelled in ${company.name} (${who}, ${vault}).`, [request.requestedBy ?? 0]);
    return request;
  }

  /** A ready request, its vault's recovery copy and the caller's recovery key copy, all current. */
  private async ready(companyId: number, userId: number, requestId: number) {
    const company = await this.company(companyId);
    const request = await this.request(companyId, requestId);
    if (!(await CompanyRecoveryService.activeCustodianIds(companyId)).includes(userId)) {
      throw new RecoveryError("Only the company's recovery custodians can do this.", 403);
    }
    if (request.status !== "approved") throw new RecoveryError("This request isn't approved.", 409);
    this.requireLive(request);
    if (!isReady(request)) throw new RecoveryError(`Not ready until ${request.availableAt.toISOString()}.`, 409);
    const collection = await Collection.findByPk(request.collectionId);
    const copy = await VaultRecoveryKey.findOne({ where: { collectionId: request.collectionId } });
    // An earlier copy without its recorded public key can't be opened (only possible for rows from before migration 052).
    const knownKey = !!copy?.recoveryPublicKey || copy?.recoveryKeyVersion === company.recoveryKeyVersion;
    if (!collection || !copy || copy.keyVersion !== collection.e2eKeyVersion || !knownKey) {
      throw new RecoveryError("This vault's recovery copy is being updated. Try again in a minute.", 409);
    }
    // The copy may be sealed to an earlier recovery key (a vault nobody holds keeps it): the caller needs that one.
    const myKey = await CompanyRecoveryKey.findOne({ where: { companyId, userId, keyVersion: copy.recoveryKeyVersion } });
    if (!myKey) {
      throw new RecoveryError(
        copy.recoveryKeyVersion === company.recoveryKeyVersion
          ? "You don't hold the recovery key yet. Another custodian gives it to you when they open 2keevo."
          : "This vault's recovery copy needs an earlier recovery key you don't hold. A custodian who held it can complete this.",
        409
      );
    }
    return { company, request, collection, copy, myKey };
  }

  /**
   * Something the vault's real key opens: its encrypted name, or one item key wrapped for it.
   * The custodian's browser tries it before sealing, so a damaged copy can't hand over a wrong key.
   */
  private async checkValue(collection: Collection, keyVersion: number) {
    if (collection.encName && collection.nameKey === `v${keyVersion}`) {
      return { kind: "name" as const, encName: collection.encName, nameKey: collection.nameKey };
    }
    const link = await ItemKey.findOne({
      where: { containerType: "collection", containerId: collection.id, keyVersion },
      attributes: ["noteId", "wrappedKey"],
    });
    const note = link ? await Note.findByPk(link.noteId, { attributes: ["id", "e2eId"], paranoid: false }) : null;
    return link && note?.e2eId ? { kind: "item" as const, e2eId: note.e2eId, wrappedKey: link.wrappedKey } : null;
  }

  async material(companyId: number, userId: number, requestId: number) {
    const { company, request, collection, copy, myKey } = await this.ready(companyId, userId, requestId);
    const grantee = await this.grantee(companyId, request.granteeUserId);
    if (!grantee) throw new RecoveryError("That person is no longer an active member with end-to-end encryption on.", 409);
    return {
      // Sent back if the copy turns out damaged, so exactly this copy is dropped.
      copyId: copy.id,
      check: await this.checkValue(collection, copy.keyVersion),
      // The key version and public key the vault's copy is sealed to.
      recoveryKeyVersion: copy.recoveryKeyVersion,
      recoveryPublicKey: (copy.recoveryPublicKey || company.recoveryPublicKey) as string,
      myKey: myKey.wrappedKey,
      vault: { collectionId: copy.collectionId, keyVersion: copy.keyVersion, wrappedKey: copy.wrappedKey },
      grantee: { userId: grantee.id, publicKey: grantee.publicKey as string },
    };
  }

  /**
   * A custodian's browser found the vault's recovery copy doesn't open the vault (damaged, or
   * saved wrongly by a key holder): it is dropped, so a key holder's app makes a new one.
   */
  async dropCopy(companyId: number, userId: number, requestId: number, copyId: number) {
    // Only where completing is allowed: approved, past the wait, by a custodian holding that copy's key
    // (the one who just found the copy doesn't open the vault).
    const { company, request, collection, copy } = await this.ready(companyId, userId, requestId);
    if (copy.id !== Number(copyId)) throw new RecoveryError("The recovery copy changed meanwhile. Try again.", 409);
    // A vault nobody holds can't get a new copy: dropping this one would lose it for good.
    // Only people who can re-make it count: active members with end-to-end on (someone who left keeps
    // their key row on purpose, but gets no continuity task). When in doubt, the copy is kept.
    const keyRows = await CollectionKey.findAll({
      where: { collectionId: collection.id, keyVersion: collection.e2eKeyVersion as number },
      attributes: ["userId"],
    });
    const activeMembers = keyRows.length
      ? await CompanyMember.findAll({
          where: { companyId, status: "active", userId: { [Op.in]: keyRows.map((row) => row.userId) } },
          attributes: ["userId"],
        })
      : [];
    const keyed = activeMembers.length
      ? await User.findAll({
          where: { id: { [Op.in]: activeMembers.map((row) => row.userId as number) }, e2eEnabled: true },
          attributes: ["id"],
        })
      : [];
    if (!keyed.length) {
      throw new RecoveryError("Nobody holds this vault's key, so its recovery copy is kept. This request can't be completed.", 409);
    }
    await VaultRecoveryKey.destroy({ where: { id: copy.id } });
    await this.notify(
      companyId,
      `The recovery copy of vault #${request.collectionId} in ${company.name} didn't open the vault and was dropped. A key holder's 2keevo makes a new one; until then it can't be recovered.`,
      [request.requestedBy ?? 0]
    );
    return request;
  }

  /** The vault key, sealed to the person in the custodian's browser: stored, with access. */
  async complete(companyId: number, userId: number, requestId: number, input: any) {
    const { company, request, collection } = await this.ready(companyId, userId, requestId);
    const keyVersion = Number(input?.keyVersion);
    if (keyVersion !== collection.e2eKeyVersion) throw new RecoveryError("The vault's key changed. Try again.", 409);
    const grantee = await this.grantee(companyId, request.granteeUserId);
    if (!grantee) throw new RecoveryError("That person is no longer an active member with end-to-end encryption on.", 409);
    // The key was sealed in the custodian's browser to this public key: it must still be theirs.
    if (typeof input?.granteePublicKey !== "string") throw new RecoveryError("Missing the person's public key.");
    if (input.granteePublicKey !== grantee.publicKey) throw new RecoveryError("That person's keys changed. Try again.", 409);
    const wrappedKey = String(input?.wrappedKey || "");
    if (!SEALED.test(wrappedKey)) throw new RecoveryError("Bad vault key copy.");
    const access = await CollectionService.getAccess(request.collectionId, grantee.id);
    const reaches =
      !!access && (access.permission === "owner" || access.permission === "edit" || access.permission === request.permission);
    // ADR-002: a vault with no active manager gets one in whoever it's recovered for.
    const needsManager = !(await CollectionService.otherManagers(companyId, request.collectionId, grantee.id)).length;
    const completedAt = new Date();
    await sequelize.transaction(async (transaction) => {
      // First, and only from approved: a cancel (or another completion) that landed meanwhile wins.
      const [changed] = await RecoveryRequest.update(
        { status: "completed", completedBy: userId, completedAt },
        { where: { id: request.id, companyId, status: "approved" }, transaction }
      );
      if (!changed) throw new RecoveryError("This request was cancelled or already completed.", 409);
      // The vault row is held until commit, so its key can't be replaced between this check and the writes.
      const locked = await Collection.findByPk(request.collectionId, { transaction, lock: true });
      if (!locked || locked.e2eKeyVersion !== keyVersion) throw new RecoveryError("The vault's key changed. Try again.", 409);
      // A key they already hold at this version stays (nobody swaps in a key of their own).
      const held = await CollectionKey.findOne({
        where: { collectionId: request.collectionId, userId: grantee.id, keyVersion },
        transaction,
      });
      if (!held) {
        await CollectionKey.destroy({ where: { collectionId: request.collectionId, userId: grantee.id }, transaction });
        await CollectionKey.create(
          { collectionId: request.collectionId, userId: grantee.id, keyVersion, wrappedKey, grantedBy: userId },
          { transaction }
        );
      }
      const share = await CollectionShare.findOne({
        where: { collectionId: request.collectionId, sharedWithUserId: grantee.id },
        transaction,
      });
      // Always a grant of their own (ADR-002), also when they reached the vault through everyone or a group;
      // permanent and never narrower than what they had.
      if (share) {
        const permission = share.permission === "edit" || reaches && access?.permission === "edit" ? "edit" : request.permission;
        await share.update({ permission, expiresAt: null, manages: share.manages || needsManager }, { transaction });
      } else {
        await CollectionShare.create(
          {
            collectionId: request.collectionId,
            sharedByUserId: userId,
            sharedWithUserId: grantee.id,
            permission: reaches && access?.permission === "edit" ? "edit" : request.permission,
            expiresAt: null,
            manages: needsManager,
            source: "recovery",
          },
          { transaction }
        );
      }
    });
    Object.assign(request, { status: "completed", completedBy: userId, completedAt });
    const { who, vault } = await this.names(request.collectionId, request.granteeUserId);
    await this.notify(companyId, `Vault recovery done in ${company.name}: ${who} now has ${request.permission} access to ${vault}.`, [
      grantee.id,
      request.requestedBy ?? 0,
    ]);
    return request;
  }
}

export default new VaultRecoveryService();
