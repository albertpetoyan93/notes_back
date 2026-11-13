import crypto from "crypto";
import { Op, Transaction } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Collection from "../models/Collection";
import CollectionKey from "../models/CollectionKey";
import CollectionNote from "../models/CollectionNote";
import CollectionShare from "../models/CollectionShare";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import { CompanyRecoveryKey, RecoveryCustodian } from "../models/CompanyRecovery";
import EmergencyContact from "../models/EmergencyContact";
import ItemKey from "../models/ItemKey";
import Note from "../models/Note";
import NoteShare from "../models/NoteShare";
import User from "../models/User";
import UserPasskey from "../models/UserPasskey";
import AuditService from "./AuditService";
import E2EAccountService, { E2EError } from "./E2EAccountService";
import EmailService from "./EmailService";
import NotificationService from "./NotificationService";
import SessionService from "./SessionService";
import TwoFactorService from "./TwoFactorService";

/**
 * Account reset (ADR-001 "Forgotten master password", E2E_DESIGN section 6
 * option 3): for someone who lost both their master password and their
 * recovery key. They prove they own the email (the reset link, 1 h, single
 * use) and, if they use 2FA, a code; their browser makes new keys. Their
 * personal end-to-end items are lost (nothing can open them any more);
 * company items, family-collection items, items not yet end-to-end
 * encrypted, memberships and their account stay. Key copies made for the old
 * keys are dropped, so owners', managers' and sharers' apps make new ones.
 */
const INVALID = "This link is invalid or has expired.";
/** Emergency access that used the old keys: it has to be confirmed again. */
const SEALED: string[] = ["confirmed", "requested", "granted"];

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const usable = (user: User | null, hash: string) => {
  const expires = user?.passwordResetExpires ? new Date(user.passwordResetExpires).getTime() : 0;
  // Any account: one that never had keys gets its first ones here (stage 10.6).
  if (!user?.passwordResetTokenHash || expires < Date.now()) return false;
  const stored = Buffer.from(user.passwordResetTokenHash);
  const given = Buffer.from(hash);
  return stored.length === given.length && crypto.timingSafeEqual(stored, given);
};

class AccountResetService {
  /** The end-to-end account a valid, unexpired reset link belongs to. */
  private async userFor(token: unknown) {
    const raw = String(token || "").trim();
    if (!raw) throw new E2EError(INVALID, 404);
    const hash = hashToken(raw);
    const user = await User.findOne({ where: { passwordResetTokenHash: hash } });
    if (!usable(user, hash)) throw new E2EError(INVALID, 404);
    return user as User;
  }

  /**
   * Personal end-to-end items (incl. trashed) that only the old keys open, and
   * how many of them others can see. Items in a company vault or a family
   * collection stay: the vault's key opens them, and others hold it.
   */
  private async personal(userId: number, transaction?: Transaction) {
    const notes = await Note.findAll({
      where: { userId, companyId: null, e2e: true },
      attributes: ["id", "collectionId"],
      paranoid: false,
      transaction,
    });
    if (!notes.length) return { ids: [] as number[], shared: 0 };
    const all = notes.map((note) => note.id);
    const links = await CollectionNote.findAll({
      where: { noteId: { [Op.in]: all } },
      attributes: ["noteId", "collectionId"],
      transaction,
    });
    const placed = [
      ...links.map((link) => ({ noteId: link.noteId, collectionId: link.collectionId })),
      ...notes.filter((note) => note.collectionId).map((note) => ({ noteId: note.id, collectionId: note.collectionId as number })),
    ];
    const collectionIds = [...new Set(placed.map((row) => row.collectionId))];
    const collections = collectionIds.length
      ? await Collection.findAll({
          where: { id: { [Op.in]: collectionIds } },
          attributes: ["id", "userId", "companyId", "family"],
          transaction,
        })
      : [];
    const ownIds = collections.filter((row) => row.userId === userId && !row.companyId && !row.family).map((row) => row.id);
    const sharedOwn = await this.sharedCollectionIds(ownIds, transaction);
    // Others open these with the collection's key: a company vault, the family collection,
    // someone else's collection, or one of Sam's that is shared.
    const sharedVault = new Set(
      collections
        .filter((row) => row.companyId || row.family || row.userId !== userId || sharedOwn.has(row.id))
        .map((row) => row.id)
    );
    const kept = new Set(placed.filter((row) => sharedVault.has(row.collectionId)).map((row) => row.noteId));
    const ids = all.filter((id) => !kept.has(id));
    if (!ids.length) return { ids, shared: 0 };

    // Only live shares: an expired one gives nobody anything.
    const direct = await NoteShare.findAll({
      where: { noteId: { [Op.in]: ids }, [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }] },
      attributes: ["noteId"],
      transaction,
    });
    return { ids, shared: new Set(direct.map((row) => row.noteId)).size };
  }

  private async sharedCollectionIds(ids: number[], transaction?: Transaction) {
    if (!ids.length) return new Set<number>();
    const shares = await CollectionShare.findAll({ where: { collectionId: { [Op.in]: ids } }, attributes: ["collectionId"], transaction });
    return new Set(shares.map((row) => row.collectionId));
  }

  /** Their own collections: shared ones stay (their people keep them), the rest go if the name was locked with the old key. */
  private async ownCollections(userId: number, transaction?: Transaction) {
    const own = await Collection.findAll({
      where: { userId, companyId: null, family: false },
      attributes: ["id", "nameKey", "e2eKeyVersion"],
      transaction,
    });
    const shared = await this.sharedCollectionIds(own.map((row) => row.id), transaction);
    return {
      deletable: own.filter((row) => !shared.has(row.id) && row.nameKey === "user").map((row) => row.id),
      lockedShared: own.filter((row) => shared.has(row.id) && row.e2eKeyVersion != null).length,
    };
  }

  /**
   * Company vaults whose current key no other active owner or admin holds:
   * only they can hand a vault key on, so nobody can give it back.
   */
  private async orphanedVaults(userId: number) {
    const mine = await CollectionKey.findAll({ where: { userId }, attributes: ["collectionId", "keyVersion"] });
    const result: { companyName: string; vaultId: number }[] = [];
    for (const key of mine) {
      const collection = await Collection.findByPk(key.collectionId);
      if (!collection?.companyId || collection.e2eKeyVersion !== key.keyVersion) continue;
      const others = await CollectionKey.findAll({
        where: { collectionId: collection.id, keyVersion: key.keyVersion, userId: { [Op.ne]: userId } },
        attributes: ["userId"],
      });
      // ADR-002: the vault's managers hand its key on (not the role), if they're still active members.
      const managing = others.length
        ? await CollectionShare.findAll({
            where: {
              collectionId: collection.id,
              sharedWithUserId: { [Op.in]: others.map((row) => row.userId) },
              manages: true,
              [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
            },
            attributes: ["sharedWithUserId"],
          })
        : [];
      const managers = managing.length
        ? await CompanyMember.count({
            where: {
              companyId: collection.companyId,
              userId: { [Op.in]: managing.map((row) => row.sharedWithUserId) },
              status: "active",
            },
          })
        : 0;
      if (managers) continue;
      const company = await Company.findByPk(collection.companyId);
      result.push({ companyName: company?.name || "", vaultId: collection.id });
    }
    return result;
  }

  /** Companies whose current vault recovery key no other active custodian holds: recovery must be set up again. */
  private async recoveryKeyLost(userId: number) {
    const mine = await CompanyRecoveryKey.findAll({ where: { userId }, attributes: ["companyId", "keyVersion"] });
    const result: { companyId: number; name: string }[] = [];
    for (const key of mine) {
      const company = await Company.findByPk(key.companyId);
      if (!company || company.recoveryKeyVersion == null || company.recoveryKeyVersion !== key.keyVersion) continue;
      const others = await CompanyRecoveryKey.findAll({
        where: { companyId: key.companyId, keyVersion: key.keyVersion, userId: { [Op.ne]: userId } },
        attributes: ["userId"],
      });
      const otherIds = others.map((row) => row.userId);
      const custodians = otherIds.length
        ? (await RecoveryCustodian.findAll({ where: { companyId: key.companyId, userId: { [Op.in]: otherIds } }, attributes: ["userId"] })).map(
            (row) => row.userId
          )
        : [];
      const active = custodians.length
        ? await CompanyMember.count({ where: { companyId: key.companyId, userId: { [Op.in]: custodians }, status: "active" } })
        : 0;
      if (!active) result.push({ companyId: company.id, name: company.name });
    }
    return result;
  }

  /** They run a family collection: only the organizer hands its key on, so nobody can give it back. */
  private async familyCollectionLocked(userId: number) {
    const own = await Collection.findAll({ where: { userId, companyId: null, family: true }, attributes: ["id", "e2eKeyVersion"] });
    return own.some((row) => row.e2eKeyVersion != null);
  }

  /** What the reset page shows before anything happens. */
  async check(token: unknown) {
    const user = await this.userFor(token);
    const { ids, shared } = await this.personal(user.id);
    return {
      email: user.email,
      twoFactor: !!user.twoFactorEnabled,
      personalItems: ids.length,
      sharedWithOthers: shared,
      orphanedVaults: await this.orphanedVaults(user.id),
      recoveryKeyLost: (await this.recoveryKeyLost(user.id)).map((row) => row.name),
      lockedSharedCollections: (await this.ownCollections(user.id)).lockedShared,
      familyCollectionLocked: await this.familyCollectionLocked(user.id),
    };
  }

  /** Reset: new keys from the browser; what only the old keys could open is deleted. */
  async reset(token: unknown, input: any) {
    if (input?.confirm !== "RESET") throw new E2EError("Type RESET to confirm.", 400);
    const user = await this.userFor(token);
    const linkHash = user.passwordResetTokenHash as string;
    // The keys first: a bad bundle mustn't use up the one 2FA try below.
    const values = await E2EAccountService.checkedBundle(input);
    const code = String(input?.twoFactorCode || "").trim();
    if (user.twoFactorEnabled && !code) throw new E2EError("Enter the code from your authenticator app.", 401);
    const lostRecovery = await this.recoveryKeyLost(user.id);

    let deleted = 0;
    let wrongCode = false;
    const toConfirmAgain: number[] = [];
    await sequelize.transaction(async (transaction) => {
      // The link is used once: another request may have used it (or burned it with a wrong code) meanwhile.
      // Parallel requests wait here, so each link gets one 2FA guess.
      const locked = await User.findOne({ where: { id: user.id }, lock: true, transaction });
      if (!usable(locked, linkHash)) throw new E2EError(INVALID, 404);
      if (user.twoFactorEnabled && !(await TwoFactorService.verify(user.id, code))) {
        // One guess per link: someone with only the inbox can't keep trying codes.
        await (locked as User).update({ passwordResetTokenHash: null, passwordResetExpires: null }, { transaction });
        wrongCode = true;
        return;
      }
      const { ids } = await this.personal(user.id, transaction);
      const { deletable } = await this.ownCollections(user.id, transaction);
      deleted = ids.length;
      await (locked as User).update(
        // The link reached this inbox: that confirms the address too.
        {
          ...values,
          mustChangeMasterPassword: false,
          passwordResetTokenHash: null,
          passwordResetExpires: null,
          ...(locked?.emailVerifiedAt ? {} : { emailVerifiedAt: new Date(), emailVerifyTokenHash: null, emailVerifyExpires: null }),
        },
        { transaction }
      );
      if (ids.length) await Note.destroy({ where: { id: { [Op.in]: ids } }, force: true, transaction });
      // Their unshared collections whose name was locked with the old key; shared and family ones stay.
      if (deletable.length) await Collection.destroy({ where: { id: { [Op.in]: deletable } }, transaction });
      await CollectionKey.destroy({ where: { userId: user.id }, transaction });
      await ItemKey.destroy({ where: { containerType: "user", containerId: user.id }, transaction });
      await CompanyRecoveryKey.destroy({ where: { userId: user.id }, transaction });
      await UserPasskey.update({ prfUserKey: null }, { where: { userId: user.id }, transaction });
      // Emergency access sealed with the old keys: confirmed again, both ways.
      const asContact = await EmergencyContact.findAll({
        where: { contactId: user.id, status: { [Op.in]: SEALED } },
        attributes: ["grantorId"],
        transaction,
      });
      toConfirmAgain.push(...asContact.map((row) => row.grantorId));
      for (const side of ["grantorId", "contactId"] as const) {
        await EmergencyContact.update(
          { status: "accepted", sealedUserKey: null },
          { where: { [side]: user.id, status: { [Op.in]: SEALED } }, transaction }
        );
      }
      await SessionService.revokeAll(user.id, undefined, transaction);
    });
    if (wrongCode) {
      const alert =
        "Someone used your account-reset link with a wrong 2FA code. The link no longer works. If this wasn't you, change your email password.";
      await NotificationService.create(user.id, alert).catch(() => undefined);
      EmailService.sendSecurityNotice({ to: user.email, what: alert }).catch(() => undefined);
      throw new E2EError("That code isn't right. For your safety this link no longer works: ask for a new one.", 401);
    }

    // Committed: what follows only tells people, and must not turn the answer into a failure.
    try {
      await this.afterReset(user, deleted, lostRecovery, toConfirmAgain);
    } catch {
      // The reset stands; a missed notice or audit line isn't worth a false "nothing changed".
    }
    return { userId: user.id, personalItemsDeleted: deleted };
  }

  private async afterReset(
    user: User,
    deleted: number,
    lostRecovery: { companyId: number; name: string }[],
    toConfirmAgain: number[]
  ) {
    const notice =
      "Your 2keevo account was reset: new master password and recovery key, personal items deleted. Company vaults come back from your company's admins, and items shared with you come back once their owners share them again (we've asked them). Confirm your emergency contacts again. If this wasn't you, contact support now.";
    await NotificationService.create(user.id, notice).catch(() => undefined);
    EmailService.sendSecurityNotice({ to: user.email, what: notice }).catch(() => undefined);
    for (const grantorId of new Set(toConfirmAgain)) {
      await NotificationService.create(
        grantorId,
        `${user.email} reset their account. Confirm them again as your emergency contact in Settings.`
      ).catch(() => undefined);
    }
    // Direct shares to them: the key copy only the old keys opened is gone; sharing again makes a new one.
    const sharedWithMe = await NoteShare.findAll({ where: { sharedWithUserId: user.id }, attributes: ["noteId"] });
    const sharers = sharedWithMe.length
      ? await Note.findAll({ where: { id: { [Op.in]: sharedWithMe.map((row) => row.noteId) } }, attributes: ["userId"] })
      : [];
    for (const sharerId of new Set(sharers.map((note) => note.userId))) {
      if (!sharerId || sharerId === user.id) continue;
      await NotificationService.create(
        sharerId,
        `${user.email} reset their account and can't open the items you shared with them. Share them again to give access back.`
      ).catch(() => undefined);
    }
    const memberships = await CompanyMember.findAll({ where: { userId: user.id, status: "active" }, attributes: ["companyId"] });
    for (const membership of memberships) {
      const owners = await CompanyMember.findAll({
        where: { companyId: membership.companyId, status: "active", role: "owner" },
        attributes: ["userId"],
      });
      const recovery = lostRecovery.some((row) => row.companyId === membership.companyId)
        ? " They were the only one holding the vault recovery key: set up vault recovery again in the company settings."
        : "";
      for (const owner of owners) {
        if (!owner.userId || owner.userId === user.id) continue;
        await NotificationService.create(
          owner.userId,
          `${user.email} reset their account. Their access to company vaults comes back from owners' and admins' 2keevo.${recovery}`
        ).catch(() => undefined);
      }
    }
    await AuditService.record({ actorId: user.id, action: "account_reset", details: { personalItemsDeleted: deleted } });
  }
}

export default new AccountResetService();
