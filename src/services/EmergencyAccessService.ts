import { Op, UniqueConstraintError } from "sequelize";
import EmailVerificationService from "./EmailVerificationService";
import { EMERGENCY_MAX_CONTACTS, EMERGENCY_WAIT_DAYS } from "../common/plans";
import Collection from "../models/Collection";
import CollectionKey from "../models/CollectionKey";
import EmergencyCollectionName from "../models/EmergencyCollectionName";
import EmergencyContact from "../models/EmergencyContact";
import EmergencyItemKey from "../models/EmergencyItemKey";
import EmergencyKey from "../models/EmergencyKey";
import Note from "../models/Note";
import CollectionService from "./CollectionService";
import { isWorkItem } from "./workItems";
import User from "../models/User";
import E2EAccountService from "./E2EAccountService";
import EmailService from "./EmailService";
import EntitlementService, { PlanLimitError } from "./EntitlementService";
import NoteService from "./NoteService";
import NotificationService from "./NotificationService";

/**
 * Emergency access (plans/vault-features.md, phase A).
 *
 * Someone (the owner) names a trusted contact. Once the contact accepts, the owner's
 * browser seals the owner's user key to the contact's public key and sends it here. The
 * contact can then ask for access; if the owner doesn't refuse within the waiting time,
 * the server hands the sealed key and the owner's personal items to the contact, read-only.
 * The server never holds anything it can open.
 *
 * Since migration 058 the sealed key is the owner's **emergency key**, not their user key
 * (plan 2026-11-20-emergency-key.md): the owner's browser wraps each personal item's key
 * and each personal collection's name with it, in the background. So a contact can open
 * the owner's personal items and nothing else: not company vaults, not what others shared
 * with the owner. Rows confirmed before 058 still hold the user key until the owner's
 * browser upgrades them.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SEALED = /^e2e1x\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,120}$/;
/** A 32-byte key wrapped with another (AES-GCM). */
const WRAPPED = /^e2e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,100}$/;
/** A collection name encrypted with the emergency key. */
const ENC_NAME = /^e2e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,2000}$/;
/** Small encrypted JSON (the pinned contact key). */
const WRAPPED_DATA = /^e2e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,400}$/;
/** Rows whose contact may hold the sealed key. */
const SEALED_STATUSES = ["confirmed", "requested", "granted"];
/** Items listed per pass: the owner's browser asks again for the rest. */
const ITEMS_PER_PASS = 500;

export class EmergencyError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const displayName = (user: Pick<User, "fullName" | "username" | "email"> | null | undefined) =>
  user?.fullName?.trim() || user?.username || user?.email || "Someone";

const iso = (date?: Date | null) => (date ? new Date(date).toISOString() : null);

/** When a request turns into access. */
const grantsAt = (row: EmergencyContact) =>
  row.requestedAt ? new Date(new Date(row.requestedAt).getTime() + row.waitDays * DAY_MS) : null;

const day = (date: Date) => date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

class EmergencyAccessService {
  /** Invites sent to this email before the account existed now belong to the account. */
  async claimInvites(userId: number, email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    // Only an account that proved it owns the address gets what was sent to it (F15).
    if (!(await EmailVerificationService.isVerifiedId(userId))) return;
    await EmergencyContact.update(
      { contactId: userId },
      { where: { email: normalized, contactId: { [Op.is]: null }, grantorId: { [Op.ne]: userId } } }
    );
  }

  /** Both sides for the Emergency access page: my contacts, and people who trust me. */
  async summary(userId: number) {
    const me = await User.findByPk(userId, { attributes: ["id", "email", "e2eEnabled"] });
    if (!me) throw new EmergencyError("Unauthorized", 401);
    await this.claimInvites(userId, me.email);
    await this.grantDue({ [Op.or]: [{ grantorId: userId }, { contactId: userId }] });

    const mine = await EmergencyContact.findAll({ where: { grantorId: userId }, order: [["createdAt", "ASC"]] });
    const trusting = await EmergencyContact.findAll({ where: { contactId: userId }, order: [["createdAt", "ASC"]] });
    const people = await User.findAll({
      where: {
        id: { [Op.in]: [...mine.map((row) => row.contactId || 0), ...trusting.map((row) => row.grantorId)] },
      },
      attributes: ["id", "email", "fullName", "username", "e2eEnabled", "publicKey"],
    });
    const person = (id?: number | null) => people.find((row) => row.id === id) || null;
    const { limits } = await EntitlementService.forUser(userId);

    return {
      e2e: !!me.e2eEnabled,
      included: limits.emergencyAccess,
      maxContacts: EMERGENCY_MAX_CONTACTS,
      waitDays: EMERGENCY_WAIT_DAYS,
      contacts: mine.map((row) => {
        const contact = person(row.contactId);
        return {
          id: row.id,
          email: row.email,
          name: contact ? displayName(contact) : null,
          status: row.status,
          waitDays: row.waitDays,
          requestedAt: iso(row.requestedAt),
          grantsAt: iso(grantsAt(row)),
          grantedAt: iso(row.grantedAt),
          // For the owner's browser to seal the key: the contact's public key (null until they have keys).
          publicKey: row.status === "accepted" && contact?.e2eEnabled ? contact.publicKey || null : null,
        };
      }),
      trustedBy: trusting.map((row) => {
        const grantor = person(row.grantorId);
        return {
          id: row.id,
          name: displayName(grantor),
          email: grantor?.email || null,
          status: row.status,
          waitDays: row.waitDays,
          requestedAt: iso(row.requestedAt),
          grantsAt: iso(grantsAt(row)),
          grantedAt: iso(row.grantedAt),
        };
      }),
    };
  }

  // ---------------------------------------------------------------- the owner

  async invite(grantorId: number, input: { email?: unknown; waitDays?: unknown }) {
    const { limits } = await EntitlementService.forUser(grantorId);
    if (!limits.emergencyAccess) {
      throw new PlanLimitError("Emergency access is part of Premium and Family. Upgrade to add a trusted contact.", "emergencyAccess");
    }
    const grantor = await User.findByPk(grantorId, { attributes: ["id", "email", "fullName", "username", "e2eEnabled"] });
    if (!grantor) throw new EmergencyError("Unauthorized", 401);
    if (!grantor.e2eEnabled) throw new EmergencyError("Turn on end-to-end encryption first.", 409);

    const email = String(input.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new EmergencyError("Enter a valid email");
    if (email === grantor.email.trim().toLowerCase()) throw new EmergencyError("You can't be your own trusted contact");
    const waitDays = this.checkWait(input.waitDays);

    if (await EmergencyContact.count({ where: { grantorId, email } })) {
      throw new EmergencyError("That person is already a trusted contact");
    }
    if ((await EmergencyContact.count({ where: { grantorId } })) >= EMERGENCY_MAX_CONTACTS) {
      throw new EmergencyError(`You can have up to ${EMERGENCY_MAX_CONTACTS} trusted contacts.`);
    }

    // Tied to an account only once it confirmed the address; otherwise claimInvites ties it after confirming.
    const account = await EmailVerificationService.confirmedAccountByEmail(email, ["id"]);
    const row = await EmergencyContact.create({ grantorId, email, contactId: account?.id ?? null, waitDays, status: "invited" });

    let emailSent = false;
    try {
      emailSent = await EmailService.sendEmergencyInvite({ to: email, from: displayName(grantor), waitDays });
    } catch {
      // The invite still shows on their Emergency access page once they sign in.
    }
    if (account) {
      await NotificationService.create(account.id, `${displayName(grantor)} asked you to be their emergency contact.`);
    }
    return { id: row.id, emailSent };
  }

  async setWait(grantorId: number, id: number, waitDays: unknown) {
    const row = await this.ownRow(grantorId, id);
    // A running request keeps the waiting time it started with.
    if (row.status === "requested") throw new EmergencyError("Refuse or wait for the current request before changing this.", 409);
    await row.update({ waitDays: this.checkWait(waitDays) });
  }

  /** The owner's browser sealed the emergency key to the contact's public key. */
  async confirm(
    grantorId: number,
    id: number,
    input: { sealedEmergencyKey?: unknown; keyVersion?: unknown; pinnedKey?: unknown; sealedUserKey?: unknown }
  ) {
    const row = await this.ownRow(grantorId, id);
    if (row.status !== "accepted") throw new EmergencyError("This contact isn't waiting to be confirmed.", 409);
    // An app from before migration 058 seals the user key: no longer accepted.
    if (!input.sealedEmergencyKey) throw new EmergencyError("Reload 2keevo and confirm again.", 409);
    const sealed = String(input.sealedEmergencyKey);
    if (!SEALED.test(sealed)) throw new EmergencyError("Bad key.");
    const pinnedKey = String(input.pinnedKey || "");
    if (!WRAPPED_DATA.test(pinnedKey)) throw new EmergencyError("Reload 2keevo and confirm again.", 409);
    const current = await EmergencyKey.findByPk(grantorId);
    if (!current || current.rotate || Number(input.keyVersion) !== current.keyVersion) {
      throw new EmergencyError("Reload 2keevo and confirm again.", 409);
    }
    await row.update({
      status: "confirmed",
      sealedEmergencyKey: sealed,
      emergencyKeyVersion: current.keyVersion,
      sealedUserKey: null,
      pinnedKey,
    });
    if (row.contactId) {
      const grantor = await User.findByPk(grantorId, { attributes: ["fullName", "username", "email"] });
      await NotificationService.create(row.contactId, `You're now ${displayName(grantor)}'s emergency contact.`);
    }
  }

  /** Grant a request now, without waiting. */
  async approve(grantorId: number, id: number) {
    const row = await this.ownRow(grantorId, id);
    if (row.status !== "requested") throw new EmergencyError("There's no request to approve.", 409);
    await this.grant(row);
  }

  /** Refuse a request, or end access already granted. The contact stays a contact. */
  async refuse(grantorId: number, id: number) {
    const row = await this.ownRow(grantorId, id);
    if (row.status !== "requested" && row.status !== "granted") throw new EmergencyError("There's no request to refuse.", 409);
    const wasGranted = row.status === "granted";
    await row.update({ status: "confirmed", requestedAt: null, grantedAt: null, remindersSent: 0 });
    if (wasGranted) await this.askForNewKey(grantorId);
    const contact = row.contactId ? await User.findByPk(row.contactId, { attributes: ["id", "email"] }) : null;
    const grantor = await User.findByPk(grantorId, { attributes: ["fullName", "username", "email"] });
    if (contact) {
      await NotificationService.create(
        contact.id,
        wasGranted ? `${displayName(grantor)} ended your emergency access.` : `${displayName(grantor)} refused your emergency access request.`
      );
      await EmailService.sendEmergencyRefused({ to: contact.email, from: displayName(grantor), ended: wasGranted }).catch(() => undefined);
    }
    return { wasGranted };
  }

  /** The owner removes a contact: the sealed key is deleted with the row. */
  async remove(grantorId: number, id: number) {
    const row = await this.ownRow(grantorId, id);
    await row.destroy();
    if (row.status === "granted") await this.askForNewKey(grantorId);
    return { contactId: row.contactId ?? null };
  }

  // ---------------------------------------------------------------- the contact

  async accept(contactId: number, id: number) {
    const row = await this.contactRow(contactId, id);
    if (row.status !== "invited") throw new EmergencyError("This invitation was already answered.", 409);
    if (!(await EmailVerificationService.isVerifiedId(contactId))) {
      throw new EmergencyError("Confirm your email first: open the link we sent you.", 403);
    }
    const contact = await User.findByPk(contactId, { attributes: ["e2eEnabled", "fullName", "username", "email"] });
    if (!contact?.e2eEnabled) throw new EmergencyError("Turn on end-to-end encryption first.", 409);
    await row.update({ status: "accepted" });
    await NotificationService.create(
      row.grantorId,
      `${displayName(contact)} accepted being your emergency contact. Open Emergency access to confirm them.`
    );
  }

  /** The contact declines an invitation, or stops being a contact. */
  async leave(contactId: number, id: number) {
    const row = await this.contactRow(contactId, id);
    await row.destroy();
    if (row.status === "granted") await this.askForNewKey(row.grantorId);
    return { grantorId: row.grantorId };
  }

  async request(contactId: number, id: number) {
    const row = await this.contactRow(contactId, id);
    if (row.status !== "confirmed") {
      throw new EmergencyError(
        row.status === "requested" || row.status === "granted" ? "You already asked." : "The owner hasn't confirmed you yet.",
        409
      );
    }
    await row.update({ status: "requested", requestedAt: new Date(), grantedAt: null, remindersSent: 0 });
    const grantor = await User.findByPk(row.grantorId, { attributes: ["id", "email"] });
    const contact = await User.findByPk(contactId, { attributes: ["fullName", "username", "email"] });
    const at = grantsAt(row) as Date;
    await NotificationService.create(
      row.grantorId,
      `${displayName(contact)} asked for emergency access to your vault. They get it on ${day(at)} unless you refuse.`
    );
    if (grantor) {
      await EmailService.sendEmergencyRequested({ to: grantor.email, from: displayName(contact), grantsAt: at, reminder: false }).catch(
        () => undefined
      );
    }
    return { grantsAt: at.toISOString() };
  }

  /**
   * The owner's personal vault, for a contact with access: the owner's user key sealed to
   * the contact, the owner's locked private key (to open collection names sealed with a
   * collection key), personal collections and items. Company collections and items others
   * shared with the owner are left out: they aren't the owner's to give.
   */
  async vault(contactId: number, id: number) {
    await this.grantDue({ id, contactId });
    const row = await this.contactRow(contactId, id);
    if (row.status !== "granted" || (!row.sealedUserKey && !row.sealedEmergencyKey)) {
      throw new EmergencyError("You don't have access to this vault.", 403);
    }
    const grantor = await User.findByPk(row.grantorId);
    if (!grantor) throw new EmergencyError("This account no longer exists.", 404);
    if (row.sealedEmergencyKey) return this.emergencyKeyVault(row, grantor);

    const collections = await Collection.findAll({
      where: { userId: grantor.id, companyId: { [Op.is]: null } },
      attributes: ["id", "name", "encName", "nameKey", "e2eKeyVersion"],
      order: [["name", "ASC"]],
    });
    const keys = collections.length
      ? await CollectionKey.findAll({
          where: { userId: grantor.id, collectionId: { [Op.in]: collections.map((row) => row.id) } },
        })
      : [];
    const { notes } = await NoteService.exportNotes(grantor.id);
    const bundle = E2EAccountService.bundle(grantor);

    return {
      owner: { id: grantor.id, name: displayName(grantor), email: grantor.email },
      grantedAt: iso(row.grantedAt),
      // Confirmed before migration 058, not upgraded yet by the owner's browser.
      scheme: "user-key",
      sealedUserKey: row.sealedUserKey,
      publicKey: bundle?.publicKey || null,
      protectedPrivateKey: bundle?.protectedPrivateKey || null,
      collections: collections.map((collection) => {
        const key = keys.find((item) => item.collectionId === collection.id && item.keyVersion === collection.e2eKeyVersion);
        return {
          id: collection.id,
          name: collection.encName ? null : collection.name,
          encName: collection.encName || null,
          nameKey: collection.nameKey || null,
          keyVersion: collection.e2eKeyVersion || null,
          collectionKey: key?.wrappedKey || null,
        };
      }),
      items: notes,
    };
  }

  /**
   * The vault through the emergency key: the sealed key, and the copies made with it.
   * Never the user key, the private key or the owner's own item keys. Items without a
   * copy yet are left out and counted (`waiting`).
   */
  private async emergencyKeyVault(row: EmergencyContact, grantor: User) {
    const keyVersion = Number(row.emergencyKeyVersion);
    const { items, collections } = await this.personalSet(grantor.id);
    const copies = await EmergencyItemKey.findAll({
      where: { grantorId: grantor.id, keyVersion, noteId: { [Op.in]: items.length ? items.map((note) => note.id) : [0] } },
    });
    const names = await EmergencyCollectionName.findAll({
      where: {
        grantorId: grantor.id,
        keyVersion,
        collectionId: { [Op.in]: collections.length ? collections.map((collection) => collection.id) : [0] },
      },
    });
    const copied = items.filter((note) => copies.some((copy) => copy.noteId === note.id));
    const notes = copied.length
      ? await Note.findAll({
          where: { id: { [Op.in]: copied.map((note) => note.id) } },
          attributes: ["id", "e2eId", "encData", "category"],
        })
      : [];
    const linked = await CollectionService.collectionsByNoteId(notes.map((note) => note.id));
    const personalCollections = new Set(collections.map((collection) => collection.id));

    return {
      owner: { id: grantor.id, name: displayName(grantor), email: grantor.email },
      grantedAt: iso(row.grantedAt),
      scheme: "emergency-key",
      keyVersion,
      sealedKey: row.sealedEmergencyKey,
      collections: collections.map((collection) => ({
        id: collection.id,
        name: null,
        encName: names.find((name) => name.collectionId === collection.id)?.encName || null,
      })),
      items: notes.map((note) => ({
        e2eId: note.e2eId,
        emergencyKey: copies.find((copy) => copy.noteId === note.id)?.wrappedKey,
        encData: note.encData,
        category: note.category,
        collectionIds: (linked.get(note.id) || []).map((collection) => collection.id).filter((id) => personalCollections.has(id)),
      })),
      waiting: items.length - copied.length,
    };
  }

  // ---------------------------------------------------------------- the emergency key

  /**
   * What the emergency key opens: the owner's personal items (owned, end-to-end,
   * not work items: the same set the contact's vault shows) and personal collections.
   */
  private async personalSet(ownerId: number) {
    const notes = await Note.findAll({
      where: { userId: ownerId, e2e: true },
      attributes: ["id", "e2eId", "companyId", "itemKey"],
      order: [["id", "ASC"]],
    });
    const linked = await CollectionService.collectionsByNoteId(notes.map((note) => note.id));
    const items = notes.filter((note) => !isWorkItem(note, linked.get(note.id) || []));
    const collections = await Collection.findAll({
      where: { userId: ownerId, companyId: { [Op.is]: null } },
      attributes: ["id", "name", "encName", "nameKey"],
    });
    return { items, collections };
  }

  /**
   * The owner's background tasks: make the first (or a new) emergency key, copy
   * missing items and names, then seal the key to contacts who don't have the
   * current one. Contacts wait until every item is copied, so an upgrade from the
   * old user-key copy never loses items. Copies of things that left the personal
   * set, or of an older key, are deleted here.
   */
  async tasks(ownerId: number) {
    // Nobody to give it to: no key and no copies are made.
    if (!(await EmergencyContact.count({ where: { grantorId: ownerId } }))) {
      // The last contact went: their copies go too.
      await EmergencyItemKey.destroy({ where: { grantorId: ownerId } });
      await EmergencyCollectionName.destroy({ where: { grantorId: ownerId } });
      return { keyVersion: null, emergencyKey: null, rotate: false, items: [], collections: [], contacts: [] };
    }
    const key = await EmergencyKey.findByPk(ownerId);
    const { items, collections } = await this.personalSet(ownerId);
    const rows = await EmergencyContact.findAll({ where: { grantorId: ownerId, status: { [Op.in]: SEALED_STATUSES } } });
    // Versions still in use: the current one, and any a contact still holds until sealed again.
    const versions = [key?.keyVersion ?? 0, ...rows.map((row) => row.emergencyKeyVersion).filter((v): v is number => !!v)];
    await this.dropStale(ownerId, versions, items.map((note) => note.id), collections.map((collection) => collection.id));

    if (!key || key.rotate) {
      return {
        keyVersion: key?.keyVersion ?? null,
        emergencyKey: key?.wrappedKey ?? null,
        rotate: true,
        items: [] as { noteId: number; e2eId: string; itemKey: string | null }[],
        collections: [] as { id: number; name: string; encName: string | null; nameKey: string | null }[],
        contacts: [] as { id: number; publicKey: string; pinnedKey: string | null }[],
      };
    }

    const copied = new Set(
      (await EmergencyItemKey.findAll({ where: { grantorId: ownerId, keyVersion: key.keyVersion }, attributes: ["noteId"] })).map(
        (row) => row.noteId
      )
    );
    const named = new Set(
      (
        await EmergencyCollectionName.findAll({
          where: { grantorId: ownerId, keyVersion: key.keyVersion },
          attributes: ["collectionId"],
        })
      ).map((row) => row.collectionId)
    );
    // With the owner's own user-key wrap: their browser opens it itself, so it can't be
    // made to copy a key it reaches through a company vault or someone's share.
    const missingItems = items
      .filter((note) => !copied.has(note.id))
      .slice(0, ITEMS_PER_PASS)
      .map((note) => ({ noteId: note.id, e2eId: String(note.e2eId), itemKey: note.itemKey ?? null }));
    const missingNames = collections
      .filter((collection) => !named.has(collection.id))
      .map((collection) => ({
        id: collection.id,
        name: collection.name,
        encName: collection.encName ?? null,
        nameKey: collection.nameKey ?? null,
      }));

    // A contact still on the old user-key copy is moved over only once every item is
    // copied, so the move never loses items. One already on the emergency key is sealed
    // again at once: waiting would leave them with nothing after a new key.
    const stale = rows.filter(
      (row) => row.contactId && row.emergencyKeyVersion !== key.keyVersion && (!missingItems.length || !row.sealedUserKey)
    );
    const people = stale.length
      ? await User.findAll({
          where: { id: { [Op.in]: stale.map((row) => row.contactId as number) } },
          attributes: ["id", "e2eEnabled", "publicKey"],
        })
      : [];
    const contacts = stale
      .map((row) => ({ row, person: people.find((person) => person.id === row.contactId) }))
      .filter(({ person }) => !!person?.e2eEnabled && !!person.publicKey)
      .map(({ row, person }) => ({ id: row.id, publicKey: person!.publicKey as string, pinnedKey: row.pinnedKey ?? null }));

    return {
      keyVersion: key.keyVersion,
      emergencyKey: key.wrappedKey,
      rotate: false,
      items: missingItems,
      collections: missingNames,
      contacts,
    };
  }

  /** Copies that open nothing the contact may see: items or collections no longer personal, or another key version. */
  private async dropStale(ownerId: number, versions: number[], itemIds: number[], collectionIds: number[]) {
    await EmergencyItemKey.destroy({
      where: {
        grantorId: ownerId,
        [Op.or]: [{ noteId: { [Op.notIn]: itemIds.length ? itemIds : [0] } }, { keyVersion: { [Op.notIn]: versions } }],
      },
    });
    await EmergencyCollectionName.destroy({
      where: {
        grantorId: ownerId,
        [Op.or]: [
          { collectionId: { [Op.notIn]: collectionIds.length ? collectionIds : [0] } },
          { keyVersion: { [Op.notIn]: versions } },
        ],
      },
    });
  }

  /** What the owner's browser made for `tasks`. */
  async saveKeys(
    ownerId: number,
    input: { keyVersion?: unknown; emergencyKey?: unknown; items?: unknown; collections?: unknown; contacts?: unknown }
  ) {
    const keyVersion = Number(input.keyVersion);
    if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new EmergencyError("Bad key version.");
    const current = await EmergencyKey.findByPk(ownerId);

    if (input.emergencyKey !== undefined) {
      const wrappedKey = String(input.emergencyKey || "");
      if (!WRAPPED.test(wrappedKey)) throw new EmergencyError("Bad key.");
      const owner = await User.findByPk(ownerId, { attributes: ["id", "e2eEnabled"] });
      if (!owner?.e2eEnabled) throw new EmergencyError("Turn on end-to-end encryption first.", 409);
      if (!current) {
        if (keyVersion !== 1) throw new EmergencyError("Reload 2keevo and try again.", 409);
        try {
          await EmergencyKey.create({ userId: ownerId, keyVersion: 1, wrappedKey, rotate: false });
        } catch (error) {
          if (error instanceof UniqueConstraintError) throw new EmergencyError("Already done in another tab.", 409);
          throw error;
        }
      } else {
        // Conditional: of two tabs making the next key, only one wins.
        const [updated] = await EmergencyKey.update(
          { keyVersion, wrappedKey, rotate: false },
          { where: { userId: ownerId, keyVersion: keyVersion - 1, rotate: true } }
        );
        if (!updated) throw new EmergencyError("Already done in another tab.", 409);
      }
      // Copies of the older key stay while a contact still holds it (until sealed again,
      // in the next pass); `tasks` drops them after that.
      return { keyVersion };
    }

    if (!current || current.rotate || current.keyVersion !== keyVersion) {
      throw new EmergencyError("Reload 2keevo and try again.", 409);
    }
    const items = (Array.isArray(input.items) ? input.items : []) as any[];
    const collections = (Array.isArray(input.collections) ? input.collections : []) as any[];
    const contacts = (Array.isArray(input.contacts) ? input.contacts : []) as any[];
    if (items.length + collections.length + contacts.length > 2000) throw new EmergencyError("Too many at once.");

    const personal = await this.personalSet(ownerId);
    const itemIds = new Set(personal.items.map((note) => note.id));
    const collectionIds = new Set(personal.collections.map((collection) => collection.id));
    for (const item of items) {
      if (!itemIds.has(Number(item?.noteId)) || !WRAPPED.test(String(item?.wrappedKey || ""))) {
        throw new EmergencyError("Only your personal items can be added.");
      }
    }
    for (const collection of collections) {
      if (!collectionIds.has(Number(collection?.collectionId)) || !ENC_NAME.test(String(collection?.encName || ""))) {
        throw new EmergencyError("Only your personal collections can be added.");
      }
    }
    const rows = contacts.length ? await EmergencyContact.findAll({ where: { grantorId: ownerId } }) : [];
    for (const contact of contacts) {
      const row = rows.find((item) => item.id === Number(contact?.id));
      if (
        !row ||
        !SEALED_STATUSES.includes(row.status) ||
        !SEALED.test(String(contact?.sealedKey || "")) ||
        (contact?.pinnedKey !== undefined && !WRAPPED_DATA.test(String(contact.pinnedKey || "")))
      ) {
        throw new EmergencyError("Contact not found", 404);
      }
    }

    // The same copy twice (two tabs) is kept once.
    const keep = async (exists: () => Promise<unknown>, create: () => Promise<unknown>) => {
      if (await exists()) return;
      try {
        await create();
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) throw error;
      }
    };
    for (const item of items) {
      const noteId = Number(item.noteId);
      await keep(
        () => EmergencyItemKey.findOne({ where: { grantorId: ownerId, noteId, keyVersion } }),
        () => EmergencyItemKey.create({ grantorId: ownerId, noteId, keyVersion, wrappedKey: String(item.wrappedKey) })
      );
    }
    for (const collection of collections) {
      const collectionId = Number(collection.collectionId);
      await keep(
        () => EmergencyCollectionName.findOne({ where: { grantorId: ownerId, collectionId, keyVersion } }),
        () => EmergencyCollectionName.create({ grantorId: ownerId, collectionId, keyVersion, encName: String(collection.encName) })
      );
    }
    for (const contact of contacts) {
      // The old user-key copy goes: from now on the contact gets the emergency key only.
      const row = rows.find((item) => item.id === Number(contact.id))!;
      await EmergencyContact.update(
        {
          sealedEmergencyKey: String(contact.sealedKey),
          emergencyKeyVersion: keyVersion,
          sealedUserKey: null,
          // First seen at the upgrade from the old copy; never replaced here.
          ...(row.pinnedKey || !contact.pinnedKey ? {} : { pinnedKey: String(contact.pinnedKey) }),
        },
        { where: { id: Number(contact.id), grantorId: ownerId, status: { [Op.in]: SEALED_STATUSES } } }
      );
    }
    return { keyVersion };
  }

  // ---------------------------------------------------------------- waiting time

  /** Requests whose wait has passed become access. Run on reads and once a day. */
  async grantDue(where: Record<string | symbol, unknown> = {}) {
    const due = await EmergencyContact.findAll({ where: { ...where, status: "requested" } as any });
    let granted = 0;
    for (const row of due) {
      const at = grantsAt(row);
      if (at && at.getTime() <= Date.now()) {
        await this.grant(row);
        granted += 1;
      }
    }
    return granted;
  }

  /** Daily: grant what's due, and remind owners halfway through the wait and a day before it ends. */
  async dailyJob() {
    const granted = await this.grantDue();
    let reminded = 0;
    const open = await EmergencyContact.findAll({ where: { status: "requested" } });
    for (const row of open) {
      const at = grantsAt(row);
      if (!at || !row.requestedAt) continue;
      const left = at.getTime() - Date.now();
      const half = (row.waitDays * DAY_MS) / 2;
      // Reminder 1 halfway (waits over 2 days), reminder 2 on the last day.
      const due = left <= DAY_MS ? 2 : left <= half && row.waitDays > 2 ? 1 : 0;
      if (due <= row.remindersSent) continue;
      const grantor = await User.findByPk(row.grantorId, { attributes: ["email"] });
      const contact = row.contactId ? await User.findByPk(row.contactId, { attributes: ["fullName", "username", "email"] }) : null;
      if (grantor) {
        await EmailService.sendEmergencyRequested({ to: grantor.email, from: displayName(contact), grantsAt: at, reminder: true }).catch(
          () => undefined
        );
      }
      await row.update({ remindersSent: due });
      reminded += 1;
    }
    return { granted, reminded };
  }

  private async grant(row: EmergencyContact) {
    // Conditional: of two callers only one grants (and emails).
    const [updated] = await EmergencyContact.update(
      { status: "granted", grantedAt: new Date() },
      { where: { id: row.id, status: "requested" } }
    );
    if (!updated) return;
    const grantor = await User.findByPk(row.grantorId, { attributes: ["id", "email", "fullName", "username"] });
    const contact = row.contactId ? await User.findByPk(row.contactId, { attributes: ["id", "email", "fullName", "username"] }) : null;
    if (contact) {
      await NotificationService.create(contact.id, `You now have emergency access to ${displayName(grantor)}'s vault.`);
      await EmailService.sendEmergencyGranted({ to: contact.email, from: displayName(grantor) }).catch(() => undefined);
    }
    if (grantor) {
      await NotificationService.create(grantor.id, `${displayName(contact)} now has emergency access to your vault.`);
      await EmailService.sendEmergencyGrantedOwner({ to: grantor.email, contact: displayName(contact) }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Access that had been granted ended: the contact may have kept the emergency key.
   * The owner's browser makes a new one on its next pass, and everything is copied
   * again, so nothing the owner adds later opens with the old key.
   */
  private async askForNewKey(ownerId: number) {
    await EmergencyKey.update({ rotate: true }, { where: { userId: ownerId } });
  }

  private checkWait(value: unknown) {
    const days = Number(value ?? 7);
    if (!EMERGENCY_WAIT_DAYS.includes(days)) throw new EmergencyError("Choose a waiting time from the list.");
    return days;
  }

  private async ownRow(grantorId: number, id: number) {
    const row = await EmergencyContact.findOne({ where: { id, grantorId } });
    if (!row) throw new EmergencyError("Contact not found", 404);
    return row;
  }

  private async contactRow(contactId: number, id: number) {
    const row = await EmergencyContact.findOne({ where: { id, contactId } });
    if (!row) throw new EmergencyError("Not found", 404);
    return row;
  }
}

export default new EmergencyAccessService();
