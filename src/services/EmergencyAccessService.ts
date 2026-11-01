import { Op } from "sequelize";
import { EMERGENCY_MAX_CONTACTS, EMERGENCY_WAIT_DAYS } from "../common/plans";
import Collection from "../models/Collection";
import CollectionKey from "../models/CollectionKey";
import EmergencyContact from "../models/EmergencyContact";
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
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SEALED = /^e2e1x\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,120}$/;

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

    const account = await User.findOne({ where: { email: { [Op.iLike]: email } }, attributes: ["id"] });
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

  /** The owner's browser sealed the user key to the contact's public key. */
  async confirm(grantorId: number, id: number, sealedUserKey: unknown) {
    const row = await this.ownRow(grantorId, id);
    if (row.status !== "accepted") throw new EmergencyError("This contact isn't waiting to be confirmed.", 409);
    const sealed = String(sealedUserKey || "");
    if (!SEALED.test(sealed)) throw new EmergencyError("Bad key.");
    await row.update({ status: "confirmed", sealedUserKey: sealed });
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
    return { contactId: row.contactId ?? null };
  }

  // ---------------------------------------------------------------- the contact

  async accept(contactId: number, id: number) {
    const row = await this.contactRow(contactId, id);
    if (row.status !== "invited") throw new EmergencyError("This invitation was already answered.", 409);
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
    if (row.status !== "granted" || !row.sealedUserKey) throw new EmergencyError("You don't have access to this vault.", 403);
    const grantor = await User.findByPk(row.grantorId);
    if (!grantor) throw new EmergencyError("This account no longer exists.", 404);

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
