import crypto from "crypto";
import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Collection from "../models/Collection";
import CollectionKey from "../models/CollectionKey";
import CollectionNote from "../models/CollectionNote";
import CollectionShare from "../models/CollectionShare";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import ItemKey from "../models/ItemKey";
import Note from "../models/Note";
import NoteShare from "../models/NoteShare";
import NoteVersion from "../models/NoteVersion";
import User from "../models/User";
import { decryptContent, encryptContent, isDecryptionFailure } from "../util/encryption";

/**
 * Items encrypted in the browser (E2E_DESIGN.md, stages 10.3 and 10.4).
 *
 * An end-to-end item opens with its own key, and every person who can reach
 * it needs a copy of that key:
 * - its owner: on the item row ("itemKey", wrapped with their user key);
 * - a direct share: an "item_keys" row sealed to that person's public key;
 * - a collection: an "item_keys" row wrapped with the collection key, whose
 *   copies ("collection_keys") are sealed to each person who may open it.
 *   A collection only its owner can see needs nothing.
 *
 * The server can't make these copies. When an action needs new ones (sharing,
 * moving into a collection…) it answers 409 "e2e_keys_needed" with what's
 * missing; the browser makes them and sends the action again with "e2eKeys".
 * When someone involved has no keys (end-to-end encryption off), it answers
 * 409 "e2e_items": the browser makes those items readable, then retries.
 *
 * Owners' and admins' browsers also do background work ("tasks"): encrypt a
 * collection once everyone in it has keys, give the key to people who just
 * got access, and replace it after someone lost access.
 */

const E2E_ID = /^[A-Za-z0-9_-]{22}$/;
const ITEM_KEY = /^e2e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,100}$/;
const SEALED_KEY = /^e2e1x\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,100}$/;
// Items can hold long notes; 2 MB is far above any real item.
const ENC_DATA = /^e2e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
const ENC_MAX = 2 * 1024 * 1024;
const BATCH = 50;

const CATEGORIES = ["note", "password", "login", "command", "ssh", "db", "address", "card", "other"];

export interface SealedItem {
  e2eId: string;
  itemKey: string;
  encData: string;
}

interface Member {
  userId: number;
  publicKey: string | null;
}

/** What the browser must make before an action can go ahead. */
export interface KeyNeeds {
  /** Seal the collection key to these people (`create`: make the key first). `myKey`: the caller's copy. */
  collections: {
    collectionId: number;
    keyVersion: number;
    create: boolean;
    members: { userId: number; publicKey: string }[];
    myKey?: string | null;
  }[];
  /** Wrap these items' keys with the collection key. */
  items: { noteId: number; e2eId: string; collectionId: number; keyVersion: number }[];
  /** Seal these items' keys to these people. */
  shares: { noteId: number; e2eId: string; userId: number; publicKey: string }[];
}

const httpError = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra });

/** Someone involved has no keys: the app makes these items readable and tries again. */
export const e2eConflict = (noteIds: number[]) =>
  httpError(
    "Someone here hasn't turned on end-to-end encryption, so these items are shared readable.",
    409,
    { code: "e2e_items", noteIds }
  );

const keysNeeded = (needs: KeyNeeds) =>
  httpError("New key copies are needed.", 409, { code: "e2e_keys_needed", needs });

/** The 409 body for either answer. */
export const e2eConflictBody = (error: any) =>
  error.code === "e2e_keys_needed"
    ? { message: error.message, code: error.code, needs: error.needs }
    : { message: error.message, code: "e2e_items", noteIds: Array.isArray(error.noteIds) ? error.noteIds : [] };

export const isE2EAnswer = (error: any) => error?.code === "e2e_items" || error?.code === "e2e_keys_needed";

export function assertEncData(value: unknown, name = "encrypted data"): string {
  const text = String(value || "");
  if (text.length > ENC_MAX || !ENC_DATA.test(text)) throw httpError(`Bad ${name}.`, 400);
  return text;
}

export function assertSealed(input: any): SealedItem {
  const e2eId = String(input?.e2eId || "");
  const itemKey = String(input?.itemKey || "");
  if (!E2E_ID.test(e2eId)) throw httpError("Bad item id.", 400);
  if (!ITEM_KEY.test(itemKey)) throw httpError("Bad item key.", 400);
  return { e2eId, itemKey, encData: assertEncData(input?.encData) };
}

const assertKey = (value: unknown, pattern: RegExp, name: string) => {
  const text = String(value || "");
  if (!pattern.test(text)) throw httpError(`Bad ${name}.`, 400);
  return text;
};

/** What an end-to-end item keeps in the readable columns. */
export const BLANK_FIELDS = {
  title: "",
  content: {},
  comment: "",
  project: null,
  tags: [] as string[],
  isEncrypted: true,
};

const activeShare = () => ({
  [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
});

const emptyNeeds = (): KeyNeeds => ({ collections: [], items: [], shares: [] });

// ---------------------------------------------------------------- collection names

const NAME_KEY = /^(user|v[1-9][0-9]{0,5})$/;

/** A collection name encrypted in the browser (it's short: 2 KB is plenty). */
export function assertEncName(value: unknown) {
  const text = String(value || "");
  if (text.length > 2048 || !ENC_DATA.test(text)) throw httpError("Bad collection name.", 400);
  return text;
}

/** What `name` holds while the real one is encrypted: unique per owner, never shown. */
export const placeholderName = () => `~${crypto.randomBytes(12).toString("base64url")}`;

/** The name the server may show or send: none while it's encrypted. */
export const collectionLabel = (collection: { name: string; encName?: string | null }) =>
  collection.encName ? "" : collection.name;

/**
 * A collection as clients get it, name-wise: readable, or encrypted with the
 * caller's way to open it (their user key, or their copy of the collection key).
 */
export const nameFields = (
  collection: { name: string; encName?: string | null; nameKey?: string | null; e2eKeyVersion?: number | null },
  myKey?: { keyVersion: number; wrappedKey: string } | null
) =>
  collection.encName
    ? {
        name: "",
        encName: collection.encName,
        nameKey: collection.nameKey,
        ...(myKey && collection.nameKey === `v${myKey.keyVersion}` ? { e2eKey: myKey.wrappedKey } : {}),
      }
    : { name: collection.name };

interface PlanOptions {
  /** Where the items are about to go, instead of where they are. */
  collectionsByNote?: Map<number, number[]>;
  /** People an item is about to be shared with, besides its current shares. */
  extraShares?: Map<number, number[]>;
  /** People about to get access to a collection. */
  extraMembers?: Map<number, number[]>;
}
const hasNeeds = (needs: KeyNeeds) => !!(needs.collections.length || needs.items.length || needs.shares.length);

class E2EItemService {
  // ---------------------------------------------------------------- who can open what

  /**
   * Everyone who may open each collection, with their public key (null without
   * keys). `extra`: people about to get access (a share being made).
   */
  async membersOf(collectionIds: number[], extra?: Map<number, number[]>) {
    const ids = [...new Set(collectionIds.filter((id) => Number.isInteger(id)))];
    const result = new Map<number, Member[]>();
    if (!ids.length) return result;
    const collections = await Collection.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ["id", "userId", "companyId", "companyShare"],
    });
    const shares = await CollectionShare.findAll({
      where: { collectionId: { [Op.in]: ids }, ...activeShare() },
      attributes: ["collectionId", "sharedWithUserId"],
    });
    const companyIds = [...new Set(collections.map((item) => item.companyId).filter((id): id is number => !!id))];
    const activeCompanies = companyIds.length
      ? new Set(
          (await Company.findAll({ where: { id: { [Op.in]: companyIds }, status: "active" }, attributes: ["id"] })).map(
            (company) => company.id
          )
        )
      : new Set<number>();
    const companyMembers = activeCompanies.size
      ? await CompanyMember.findAll({
          where: { companyId: { [Op.in]: [...activeCompanies] }, status: "active", userId: { [Op.not]: null } },
          attributes: ["companyId", "userId", "role"],
        })
      : [];

    const idsByCollection = new Map<number, Set<number>>();
    for (const collection of collections) {
      const people = new Set<number>();
      const sharedWith = shares
        .filter((share) => share.collectionId === collection.id)
        .map((share) => share.sharedWithUserId);
      if (collection.companyId) {
        if (activeCompanies.has(collection.companyId)) {
          const everyone = collection.companyShare === "view" || collection.companyShare === "edit";
          for (const member of companyMembers.filter((row) => row.companyId === collection.companyId)) {
            const userId = member.userId as number;
            if (member.role !== "member" || everyone || sharedWith.includes(userId)) people.add(userId);
          }
        }
      } else {
        people.add(collection.userId);
        sharedWith.forEach((userId) => people.add(userId));
      }
      (extra?.get(collection.id) || []).forEach((userId) => people.add(userId));
      idsByCollection.set(collection.id, people);
    }

    const userIds = [...new Set([...idsByCollection.values()].flatMap((set) => [...set]))];
    const users = userIds.length
      ? await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ["id", "e2eEnabled", "publicKey"] })
      : [];
    const keyOf = new Map(users.map((user) => [user.id, user.e2eEnabled && user.publicKey ? user.publicKey : null]));
    for (const [collectionId, people] of idsByCollection) {
      result.set(
        collectionId,
        [...people].map((userId) => ({ userId, publicKey: keyOf.get(userId) ?? null }))
      );
    }
    return result;
  }

  private async publicKeys(userIds: number[]) {
    const ids = [...new Set(userIds)];
    const users = ids.length
      ? await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "e2eEnabled", "publicKey"] })
      : [];
    return new Map(users.map((user) => [user.id, user.e2eEnabled && user.publicKey ? user.publicKey : null]));
  }

  private async linkedCollectionIds(noteIds: number[]) {
    const map = new Map<number, Set<number>>();
    if (!noteIds.length) return map;
    const links = await CollectionNote.findAll({ where: { noteId: { [Op.in]: noteIds } }, attributes: ["noteId", "collectionId"] });
    const legacy = await Note.findAll({
      where: { id: { [Op.in]: noteIds }, collectionId: { [Op.not]: null } },
      attributes: ["id", "collectionId"],
      paranoid: false,
    });
    const add = (noteId: number, collectionId: number) => {
      const set = map.get(noteId) || new Set<number>();
      set.add(collectionId);
      map.set(noteId, set);
    };
    links.forEach((link) => add(link.noteId, link.collectionId));
    legacy.forEach((note) => add(note.id, note.collectionId as number));
    return map;
  }

  private async shareRecipients(noteIds: number[]) {
    const map = new Map<number, Set<number>>();
    if (!noteIds.length) return map;
    const shares = await NoteShare.findAll({
      where: { noteId: { [Op.in]: noteIds }, ...activeShare() },
      attributes: ["noteId", "sharedWithUserId"],
    });
    shares.forEach((share) => {
      const set = map.get(share.noteId) || new Set<number>();
      set.add(share.sharedWithUserId);
      map.set(share.noteId, set);
    });
    return map;
  }

  /**
   * What these end-to-end items need so that everyone who can reach them can
   * open them. `collectionsByNote` / `sharesByNote`: where they're about to go
   * (instead of where they are now, or in addition for shares).
   */
  async plan(
    callerId: number,
    notes: Pick<Note, "id" | "userId" | "e2eId">[],
    options: PlanOptions = {}
  ) {
    const needs = emptyNeeds();
    const blocked = new Set<number>();
    if (!notes.length) return { needs, blocked };
    const noteIds = notes.map((note) => note.id);
    const current = await this.linkedCollectionIds(noteIds);
    const collectionsOf = (noteId: number) =>
      options.collectionsByNote?.has(noteId)
        ? [...new Set(options.collectionsByNote.get(noteId) || [])]
        : [...(current.get(noteId) || [])];
    const recipients = await this.shareRecipients(noteIds);
    const sharesOf = (noteId: number) => [
      ...new Set([...(recipients.get(noteId) || []), ...(options.extraShares?.get(noteId) || [])]),
    ];

    const allCollections = [...new Set(notes.flatMap((note) => collectionsOf(note.id)))];
    const members = await this.membersOf(allCollections, options.extraMembers);
    const collections = allCollections.length
      ? await Collection.findAll({
          where: { id: { [Op.in]: allCollections } },
          attributes: ["id", "companyId", "userId", "e2eKeyVersion"],
        })
      : [];
    const collectionById = new Map(collections.map((item) => [item.id, item]));
    const myKeys = allCollections.length
      ? await CollectionKey.findAll({ where: { collectionId: { [Op.in]: allCollections }, userId: callerId } })
      : [];
    const myKeyOf = new Map(myKeys.map((row) => [row.collectionId, row]));
    const itemKeys = await ItemKey.findAll({ where: { noteId: { [Op.in]: noteIds } } });
    const hasItemKey = (noteId: number, type: string, containerId: number, version?: number | null) =>
      itemKeys.some(
        (row) =>
          row.noteId === noteId &&
          row.containerType === type &&
          row.containerId === containerId &&
          (version === undefined || row.keyVersion === version)
      );
    const keyOfUser = await this.publicKeys(notes.flatMap((note) => sharesOf(note.id)));

    const collectionNeed = (collectionId: number, keyVersion: number, create: boolean) => {
      let entry = needs.collections.find((item) => item.collectionId === collectionId);
      if (!entry) {
        entry = {
          collectionId,
          keyVersion,
          create,
          members: create
            ? (members.get(collectionId) || []).map((member) => ({ userId: member.userId, publicKey: member.publicKey as string }))
            : [],
          myKey: create ? null : myKeyOf.get(collectionId)?.wrappedKey || null,
        };
        needs.collections.push(entry);
      }
      return entry;
    };

    for (const note of notes) {
      for (const collectionId of collectionsOf(note.id)) {
        const collection = collectionById.get(collectionId);
        const people = members.get(collectionId) || [];
        if (!collection) continue;
        // Only the item's owner can see it: their own copy is enough.
        if (!collection.companyId && people.length === 1 && people[0].userId === note.userId) continue;
        if (collection.e2eKeyVersion == null) {
          if (!people.every((member) => member.publicKey)) {
            blocked.add(note.id);
            continue;
          }
          collectionNeed(collectionId, 1, true);
          needs.items.push({ noteId: note.id, e2eId: String(note.e2eId), collectionId, keyVersion: 1 });
          continue;
        }
        if (hasItemKey(note.id, "collection", collectionId, collection.e2eKeyVersion)) continue;
        // The caller must hold the collection key to wrap the item key with it.
        if (myKeyOf.get(collectionId)?.keyVersion !== collection.e2eKeyVersion) {
          blocked.add(note.id);
          continue;
        }
        collectionNeed(collectionId, collection.e2eKeyVersion, false);
        needs.items.push({ noteId: note.id, e2eId: String(note.e2eId), collectionId, keyVersion: collection.e2eKeyVersion });
      }
      for (const userId of sharesOf(note.id)) {
        if (userId === note.userId) continue;
        const publicKey = keyOfUser.get(userId);
        if (!publicKey) {
          blocked.add(note.id);
          continue;
        }
        if (!hasItemKey(note.id, "user", userId)) {
          needs.shares.push({ noteId: note.id, e2eId: String(note.e2eId), userId, publicKey });
        }
      }
    }
    // Items made readable need nothing more.
    needs.items = needs.items.filter((item) => !blocked.has(item.noteId));
    needs.shares = needs.shares.filter((item) => !blocked.has(item.noteId));
    needs.collections = needs.collections.filter((entry) =>
      needs.items.some((item) => item.collectionId === entry.collectionId)
    );
    return { needs, blocked };
  }

  /**
   * Before an action: store the key copies the browser sent, then make sure
   * nothing else is missing. Throws the 409 answers described above.
   */
  async ensure(
    callerId: number,
    noteIds: number[],
    e2eKeys: unknown,
    options: PlanOptions = {}
  ) {
    const notes = noteIds.length
      ? await Note.findAll({
          where: { id: { [Op.in]: [...new Set(noteIds)] }, e2e: true },
          attributes: ["id", "userId", "e2eId"],
          paranoid: false,
        })
      : [];
    if (!notes.length) return;
    if (e2eKeys) await this.applyKeys(callerId, e2eKeys, options.collectionsByNote, options.extraMembers);
    const { needs, blocked } = await this.plan(callerId, notes, options);
    if (blocked.size) throw e2eConflict([...blocked]);
    if (hasNeeds(needs)) throw keysNeeded(needs);
  }

  /** Store key copies made in the browser, after checking each one belongs. */
  async applyKeys(
    callerId: number,
    input: any,
    joining?: Map<number, number[]>,
    extraMembers?: Map<number, number[]>
  ) {
    const collectionEntries = Array.isArray(input?.collections) ? input.collections.slice(0, 200) : [];
    const itemEntries = Array.isArray(input?.items) ? input.items.slice(0, 2000) : [];
    const shareEntries = Array.isArray(input?.shares) ? input.shares.slice(0, 2000) : [];
    const collectionIds = [
      ...collectionEntries.map((entry: any) => Number(entry?.collectionId)),
      ...itemEntries.map((entry: any) => Number(entry?.collectionId)),
    ].filter((id) => Number.isInteger(id));
    const members = await this.membersOf(collectionIds, extraMembers);

    await sequelize.transaction(async (transaction) => {
      for (const entry of collectionEntries) {
        const collectionId = Number(entry?.collectionId);
        const keyVersion = Number(entry?.keyVersion);
        const collection = await Collection.findByPk(collectionId, { transaction, lock: transaction.LOCK.UPDATE });
        const people = members.get(collectionId) || [];
        if (!collection || !people.some((member) => member.userId === callerId)) {
          throw httpError("You can't give keys for this collection.", 403);
        }
        const keys = (Array.isArray(entry?.keys) ? entry.keys : []).map((key: any) => ({
          userId: Number(key?.userId),
          wrappedKey: assertKey(key?.wrappedKey, SEALED_KEY, "collection key"),
        }));
        if (keys.some((key: { userId: number }) => !people.some((member) => member.userId === key.userId))) {
          throw httpError("A key was made for someone without access.", 400);
        }
        if (collection.e2eKeyVersion == null) {
          // A new collection key: everyone with access gets a copy at once.
          const covered = new Set(keys.map((key: { userId: number }) => key.userId));
          if (keyVersion !== 1 || !people.every((member) => member.publicKey && covered.has(member.userId))) {
            throw httpError("A new collection key must be sealed to everyone with access.", 409);
          }
          await CollectionKey.destroy({ where: { collectionId }, transaction });
          await collection.update({ e2eKeyVersion: 1 }, { transaction });
        } else if (entry?.create === true || keyVersion !== collection.e2eKeyVersion) {
          // Someone else made (or replaced) the key meanwhile: this one is stale.
          throw httpError("The collection key changed. Try again.", 409);
        } else {
          // Giving the existing key: only to people without a copy. A copy is
          // never replaced here, so no member can swap in a key of their own.
          const held = await CollectionKey.findAll({
            where: { collectionId, keyVersion },
            attributes: ["userId"],
            transaction,
          });
          const has = new Set(held.map((row) => row.userId));
          keys.splice(0, keys.length, ...keys.filter((key: { userId: number }) => !has.has(key.userId)));
        }
        for (const key of keys) {
          await CollectionKey.destroy({ where: { collectionId, userId: key.userId }, transaction });
          await CollectionKey.create(
            { collectionId, userId: key.userId, keyVersion, wrappedKey: key.wrappedKey, grantedBy: callerId },
            { transaction }
          );
        }
      }

      for (const entry of itemEntries) {
        const noteId = Number(entry?.noteId);
        const collectionId = Number(entry?.collectionId);
        const keyVersion = Number(entry?.keyVersion);
        const wrappedKey = assertKey(entry?.wrappedKey, ITEM_KEY, "item key");
        const note = await Note.findOne({ where: { id: noteId, e2e: true }, attributes: ["id", "userId"], paranoid: false, transaction });
        const collection = await Collection.findByPk(collectionId, { attributes: ["id", "e2eKeyVersion"], transaction });
        const people = members.get(collectionId) || [];
        const inCollection =
          (await CollectionNote.count({ where: { noteId, collectionId }, transaction })) > 0 ||
          !!joining?.get(noteId)?.includes(collectionId);
        if (
          !note ||
          !collection ||
          collection.e2eKeyVersion !== keyVersion ||
          !inCollection ||
          !(note.userId === callerId || people.some((member) => member.userId === callerId))
        ) {
          throw httpError("An item key doesn't fit its collection. Try again.", 409);
        }
        // Already there for this key: kept, so a member can't replace it with another.
        const existing = await ItemKey.findOne({
          where: { noteId, containerType: "collection", containerId: collectionId },
          attributes: ["id", "keyVersion"],
          transaction,
        });
        if (existing && existing.keyVersion === keyVersion) continue;
        await ItemKey.destroy({ where: { noteId, containerType: "collection", containerId: collectionId }, transaction });
        await ItemKey.create(
          { noteId, containerType: "collection", containerId: collectionId, keyVersion, wrappedKey },
          { transaction }
        );
      }

      for (const entry of shareEntries) {
        const noteId = Number(entry?.noteId);
        const userId = Number(entry?.userId);
        const wrappedKey = assertKey(entry?.wrappedKey, SEALED_KEY, "shared key");
        const note = await Note.findOne({ where: { id: noteId, e2e: true }, attributes: ["id", "userId"], paranoid: false, transaction });
        if (!note || note.userId !== callerId) throw httpError("Only the owner shares an item.", 403);
        await ItemKey.destroy({ where: { noteId, containerType: "user", containerId: userId }, transaction });
        await ItemKey.create({ noteId, containerType: "user", containerId: userId, wrappedKey }, { transaction });
      }
    });
  }

  /**
   * Before a collection is shared with more people. A readable collection
   * holding end-to-end items gets a key now (or, if someone has no keys, those
   * items are made readable); an encrypted one gives its key to the newcomers
   * who have keys. Newcomers without keys see its items once they turn
   * end-to-end encryption on and an owner or admin gives them the key.
   */
  async ensureCollectionShare(callerId: number, collectionId: number, recipientIds: number[], e2eKeys: unknown) {
    const extraMembers = new Map([[collectionId, recipientIds]]);
    const links = await CollectionNote.findAll({ where: { collectionId }, attributes: ["noteId"] });
    const noteIds = links.map((link) => link.noteId);
    const sealedNotes = noteIds.length
      ? await Note.findAll({
          where: { id: { [Op.in]: noteIds }, e2e: true },
          attributes: ["id", "userId", "e2eId"],
          paranoid: false,
        })
      : [];
    if (e2eKeys) await this.applyKeys(callerId, e2eKeys, undefined, extraMembers);
    const collection = await Collection.findByPk(collectionId, { attributes: ["id", "e2eKeyVersion"] });
    if (!collection) return;
    if (collection.e2eKeyVersion == null) {
      if (!sealedNotes.length) return;
      const { needs, blocked } = await this.plan(callerId, sealedNotes, { extraMembers });
      if (blocked.size) throw e2eConflict([...blocked]);
      if (hasNeeds(needs)) throw keysNeeded(needs);
      return;
    }
    const people = (await this.membersOf([collectionId], extraMembers)).get(collectionId) || [];
    const holders = await CollectionKey.findAll({ where: { collectionId, keyVersion: collection.e2eKeyVersion } });
    const missing = people.filter(
      (member) => member.publicKey && recipientIds.includes(member.userId) && !holders.some((row) => row.userId === member.userId)
    );
    const mine = holders.find((row) => row.userId === callerId);
    // Without the key here, an owner's or admin's browser hands it over later.
    if (!missing.length || !mine) return;
    throw keysNeeded({
      collections: [
        {
          collectionId,
          keyVersion: collection.e2eKeyVersion,
          create: false,
          myKey: mine.wrappedKey,
          members: missing.map((member) => ({ userId: member.userId, publicKey: member.publicKey as string })),
        },
      ],
      items: [],
      shares: [],
    });
  }

  /**
   * Before a new end-to-end item is stored in these collections: the key
   * copies it needs, sent without a note id (it has none yet). Returns the
   * item keys to store once the item exists.
   */
  async ensureNew(callerId: number, e2eId: string, collectionIds: number[], e2eKeys: any) {
    const input = e2eKeys || {};
    if (Array.isArray(input.collections) && input.collections.length) {
      await this.applyKeys(callerId, { collections: input.collections });
    }
    const draft = { id: 0, userId: callerId, e2eId } as Note;
    const { needs, blocked } = await this.plan(callerId, [draft], {
      collectionsByNote: new Map([[0, collectionIds]]),
    });
    // No id yet: the app saves it as a readable item instead.
    if (blocked.size) throw e2eConflict([]);
    const sent = (Array.isArray(input.items) ? input.items : []).map((item: any) => ({
      collectionId: Number(item?.collectionId),
      keyVersion: Number(item?.keyVersion),
      wrappedKey: assertKey(item?.wrappedKey, ITEM_KEY, "item key"),
    }));
    const missing = needs.items.filter(
      (need) => !sent.some((item: any) => item.collectionId === need.collectionId && item.keyVersion === need.keyVersion)
    );
    if (missing.length) {
      throw keysNeeded({
        items: missing,
        collections: needs.collections.filter((entry) => missing.some((item) => item.collectionId === entry.collectionId)),
        shares: [],
      });
    }
    return sent.filter((item: any) => needs.items.some((need) => need.collectionId === item.collectionId));
  }

  /** After the new item exists: store its collection key copies. */
  async storeNewItemKeys(noteId: number, keys: { collectionId: number; keyVersion: number; wrappedKey: string }[]) {
    for (const key of keys) {
      await ItemKey.create({
        noteId,
        containerType: "collection",
        containerId: key.collectionId,
        keyVersion: key.keyVersion,
        wrappedKey: key.wrappedKey,
      });
    }
  }

  /** A way in was removed: its key copy goes too. */
  async dropItemKey(noteId: number, containerType: "user" | "collection", containerId: number) {
    await ItemKey.destroy({ where: { noteId, containerType, containerId } });
  }

  /** The collection is gone: so are its key copies. */
  async dropCollection(collectionId: number) {
    await ItemKey.destroy({ where: { containerType: "collection", containerId: collectionId } });
    await CollectionKey.destroy({ where: { collectionId } });
  }

  /**
   * For each end-to-end item, the ways this person can open it besides being
   * its owner: a key shared with them, or a collection key they hold.
   */
  async keyPathsFor(userId: number, notes: Pick<Note, "id" | "e2e" | "userId">[]) {
    const result = new Map<number, { share?: string; collections: { collectionId: number; keyVersion: number; itemKey: string; collectionKey: string }[] }>();
    const sealed = notes.filter((note) => note.e2e);
    if (!sealed.length) return result;
    const ids = sealed.map((note) => note.id);
    const itemKeys = await ItemKey.findAll({ where: { noteId: { [Op.in]: ids } } });
    const collectionIds = [
      ...new Set(itemKeys.filter((row) => row.containerType === "collection").map((row) => row.containerId)),
    ];
    const mine = collectionIds.length
      ? await CollectionKey.findAll({ where: { collectionId: { [Op.in]: collectionIds }, userId } })
      : [];
    const myKeyOf = new Map(mine.map((row) => [row.collectionId, row]));
    for (const note of sealed) {
      const rows = itemKeys.filter((row) => row.noteId === note.id);
      const share = rows.find((row) => row.containerType === "user" && row.containerId === userId)?.wrappedKey;
      const collections = rows
        .filter((row) => row.containerType === "collection")
        .map((row) => {
          const key = myKeyOf.get(row.containerId);
          return key && key.keyVersion === row.keyVersion
            ? { collectionId: row.containerId, keyVersion: key.keyVersion, itemKey: row.wrappedKey, collectionKey: key.wrappedKey }
            : null;
        })
        .filter((path): path is NonNullable<typeof path> => !!path);
      result.set(note.id, { ...(share ? { share } : {}), collections });
    }
    return result;
  }

  // ---------------------------------------------------------------- moving existing items

  private plainVersion(row: NoteVersion) {
    let content: any = decryptContent(row.content);
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        /* Plain text content stays a string. */
      }
    }
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      tags: row.tags || [],
      content,
      changes: row.changes || [],
    };
  }

  /**
   * The owner's items that can move now, readable, for the browser to encrypt,
   * with the key copies each one needs (shares, collections). Saved passkeys
   * move too (the extension opens sealed items since stage 10.5). An item waits while someone who can reach it has no keys, or while one of
   * its shared collections isn't encrypted yet.
   */
  async pending(userId: number) {
    const candidates = await Note.findAll({
      where: { userId, e2e: false },
      order: [["id", "ASC"]],
      paranoid: false,
    });
    const items = [];
    let remaining = 0;
    // Planned as if already end-to-end (a stand-in id for the item key), many
    // at a time; each item then takes its own part of the plan.
    const readable = candidates.filter((note) => !isDecryptionFailure(note.content));
    const plans = new Map<number, ReturnType<typeof emptyNeeds>>();
    for (let start = 0; start < readable.length; start += 500) {
      const chunk = readable.slice(start, start + 500);
      const { needs, blocked } = await this.plan(
        userId,
        chunk.map((note) => ({ id: note.id, userId: note.userId, e2eId: "" }) as Note)
      );
      const created = new Set(needs.collections.filter((entry) => entry.create).map((entry) => entry.collectionId));
      for (const note of chunk) {
        const noteItems = needs.items.filter((need) => need.noteId === note.id);
        // Blocked, or waiting for a collection to get its key first.
        if (blocked.has(note.id) || noteItems.some((need) => created.has(need.collectionId))) continue;
        const ids = new Set(noteItems.map((need) => need.collectionId));
        plans.set(note.id, {
          ...emptyNeeds(),
          shares: needs.shares.filter((need) => need.noteId === note.id),
          items: noteItems,
          collections: needs.collections.filter((entry) => ids.has(entry.collectionId)),
        });
      }
    }
    for (const note of readable) {
      const needs = plans.get(note.id);
      if (!needs) continue;
      if (items.length >= BATCH) {
        remaining += 1;
        continue;
      }
      const versions = await NoteVersion.findAll({ where: { noteId: note.id }, order: [["id", "ASC"]] });
      const readable = versions.map((row) => this.plainVersion(row));
      if (readable.some((version) => isDecryptionFailure(version.content))) continue;
      items.push({
        id: note.id,
        title: note.title,
        content: note.content,
        comment: note.comment || "",
        project: note.project || null,
        tags: note.tags || [],
        category: note.category,
        updatedAt: note.updatedAt,
        versions: readable,
        needs: {
          shares: needs.shares.map(({ userId: recipient, publicKey }) => ({ userId: recipient, publicKey })),
          collections: needs.collections.map(({ collectionId, keyVersion, myKey }) => ({ collectionId, keyVersion, myKey })),
        },
      });
    }
    return { items, remaining };
  }

  /** Store the browser-encrypted copies and delete the readable ones. */
  async migrate(userId: number, input: unknown) {
    const list = Array.isArray(input) ? input.slice(0, BATCH) : [];
    let moved = 0;
    const skipped: number[] = [];
    for (const raw of list as any[]) {
      const noteId = Number(raw?.id);
      try {
        const sealed = assertSealed(raw);
        const versions = Array.isArray(raw?.versions) ? raw.versions : [];
        const shareKeys = (Array.isArray(raw?.shares) ? raw.shares : []).map((entry: any) => ({
          userId: Number(entry?.userId),
          wrappedKey: assertKey(entry?.wrappedKey, SEALED_KEY, "shared key"),
        }));
        const collectionKeys = (Array.isArray(raw?.collections) ? raw.collections : []).map((entry: any) => ({
          collectionId: Number(entry?.collectionId),
          keyVersion: Number(entry?.keyVersion),
          wrappedKey: assertKey(entry?.wrappedKey, ITEM_KEY, "item key"),
        }));
        const done = await sequelize.transaction(async (transaction) => {
          const note = await Note.findOne({
            where: { id: noteId, userId },
            paranoid: false,
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!note || note.e2e) return false;
          // Changed since the browser read it (an edit from another device):
          // the encrypted copy would undo it. Skipped; it moves next time.
          const readAt = new Date(raw?.updatedAt).getTime();
          if (!Number.isFinite(readAt) || new Date(note.updatedAt).getTime() !== readAt) return false;
          // Every way in must be covered by what the browser sent.
          const { needs, blocked } = await this.plan(userId, [{ id: note.id, userId: note.userId, e2eId: "" } as Note]);
          if (blocked.size || needs.collections.some((entry) => entry.create)) return false;
          const coversShares = needs.shares.every((need) => shareKeys.some((key: any) => key.userId === need.userId));
          const coversCollections = needs.items.every((need) =>
            collectionKeys.some((key: any) => key.collectionId === need.collectionId && key.keyVersion === need.keyVersion)
          );
          if (!coversShares || !coversCollections) return false;

          const encrypted = new Map<number, string>();
          for (const version of versions) {
            encrypted.set(Number(version?.id), assertEncData(version?.encData, "version"));
          }
          const rows = await NoteVersion.findAll({ where: { noteId }, attributes: ["id"], transaction });
          for (const row of rows) {
            const encData = encrypted.get(row.id);
            // A version the browser didn't send would stay readable: drop it.
            if (!encData) {
              await row.destroy({ transaction });
              continue;
            }
            await NoteVersion.update(
              { content: encData, e2e: true, title: "", tags: [], changes: [] },
              { where: { id: row.id }, transaction }
            );
          }
          await ItemKey.destroy({ where: { noteId }, transaction });
          for (const key of shareKeys.filter((key: any) => needs.shares.some((need) => need.userId === key.userId))) {
            await ItemKey.create({ noteId, containerType: "user", containerId: key.userId, wrappedKey: key.wrappedKey }, { transaction });
          }
          for (const key of collectionKeys.filter((key: any) => needs.items.some((need) => need.collectionId === key.collectionId))) {
            await ItemKey.create(
              { noteId, containerType: "collection", containerId: key.collectionId, keyVersion: key.keyVersion, wrappedKey: key.wrappedKey },
              { transaction }
            );
          }
          // silent: the item didn't change, so its "updated" date (sorting,
          // old-password health, leak results) stays as it was.
          await note.update({ ...BLANK_FIELDS, ...sealed, e2e: true }, { transaction, silent: true });
          await this.forgetTitles(noteId, transaction);
          return true;
        });
        if (done) moved += 1;
        else skipped.push(noteId);
      } catch (error: any) {
        if (error?.status !== 400) console.error("Could not move item", noteId, error?.message || error);
        skipped.push(noteId);
      }
    }
    return { moved, skipped };
  }

  /** The activity log copied item titles; an end-to-end item keeps none. */
  private async forgetTitles(noteId: number, transaction?: any) {
    await sequelize.query(
      `UPDATE "audit_events" SET details = details - 'title' WHERE "noteId" = :noteId AND details ? 'title'`,
      { replacements: { noteId }, transaction }
    );
  }

  /**
   * Make end-to-end items readable again, to share them with someone who has
   * no keys. The browser sends them decrypted, with their versions. Anyone
   * who may edit an item may do this.
   */
  async unseal(userId: number, input: unknown, canEdit: (noteId: number) => Promise<boolean>) {
    const list = Array.isArray(input) ? input.slice(0, BATCH) : [];
    const done: number[] = [];
    for (const raw of list as any[]) {
      const noteId = Number(raw?.id);
      const title = String(raw?.title ?? "").trim().slice(0, 255);
      if (!title || !raw?.content || typeof raw.content !== "object") {
        throw httpError("Each item needs its title and content.", 400);
      }
      if (!(await canEdit(noteId))) continue;
      const category = CATEGORIES.includes(raw?.category) ? raw.category : undefined;
      await sequelize.transaction(async (transaction) => {
        const note = await Note.findOne({ where: { id: noteId, e2e: true }, paranoid: false, transaction });
        if (!note) return;
        const versions = new Map<number, any>(
          (Array.isArray(raw?.versions) ? raw.versions : []).map((version: any) => [Number(version?.id), version])
        );
        const rows = await NoteVersion.findAll({ where: { noteId, e2e: true }, attributes: ["id"], transaction });
        for (const row of rows) {
          const version = versions.get(row.id);
          if (!version || !version.content || typeof version.content !== "object") {
            await row.destroy({ transaction });
            continue;
          }
          await NoteVersion.update(
            {
              e2e: false,
              title: String(version.title || "").slice(0, 255),
              category: CATEGORIES.includes(version.category) ? version.category : note.category,
              tags: Array.isArray(version.tags) ? version.tags.map(String).slice(0, 20) : [],
              changes: Array.isArray(version.changes) ? version.changes.map(String).slice(0, 50) : [],
              content: encryptContent(JSON.stringify(version.content)),
            },
            { where: { id: row.id }, transaction }
          );
        }
        await ItemKey.destroy({ where: { noteId }, transaction });
        await note.update(
          {
            title,
            content: raw.content,
            comment: String(raw?.comment || "").slice(0, 255),
            project: raw?.project ? String(raw.project).slice(0, 100) : null,
            tags: Array.isArray(raw?.tags) ? raw.tags.map(String).filter(Boolean).slice(0, 20) : [],
            ...(category ? { category } : {}),
            e2e: false,
            e2eId: null,
            itemKey: null,
            encData: null,
          },
          { transaction, silent: true }
        );
        done.push(noteId);
      });
    }
    return { unsealed: done };
  }

  // ---------------------------------------------------------------- background work for owners and admins

  /** Collections this person manages: their own, and every collection of companies they own or administer. */
  private async managedCollections(userId: number) {
    const roles = await CompanyMember.findAll({
      where: { userId, status: "active", role: { [Op.in]: ["owner", "admin"] } },
      attributes: ["companyId"],
    });
    const companyIds = roles.map((row) => row.companyId);
    const activeCompanies = companyIds.length
      ? (await Company.findAll({ where: { id: { [Op.in]: companyIds }, status: "active" }, attributes: ["id"] })).map(
          (company) => company.id
        )
      : [];
    return Collection.findAll({
      where: {
        [Op.or]: [
          { userId, companyId: null },
          ...(activeCompanies.length ? [{ companyId: { [Op.in]: activeCompanies } }] : []),
        ],
      },
      attributes: ["id", "name", "userId", "companyId", "e2eKeyVersion", "encName", "nameKey"],
    });
  }

  /**
   * What this person's browser should do for the collections they manage:
   * - encrypt: everyone with access has keys, so the collection can get one;
   * - grant: people with access (and keys) who don't have the collection key yet;
   * - rotate: someone who held the key lost access, so a new key replaces it.
   */
  async tasks(userId: number) {
    const collections = await this.managedCollections(userId);
    const ids = collections.map((item) => item.id);
    const members = await this.membersOf(ids);
    const holders = ids.length ? await CollectionKey.findAll({ where: { collectionId: { [Op.in]: ids } } }) : [];
    const encrypt: KeyNeeds["collections"] = [];
    const grant: (KeyNeeds["collections"][number] & { names?: string[] })[] = [];
    const rotate = [];
    for (const collection of collections) {
      const people = members.get(collection.id) || [];
      const keyed = people.filter((member) => member.publicKey);
      if (collection.e2eKeyVersion == null) {
        // A company's collection, or a personal one shared with someone; and
        // everyone with access has keys.
        const shared = collection.companyId ? people.length >= 1 : people.length >= 2;
        if (shared && keyed.length === people.length) {
          encrypt.push({
            collectionId: collection.id,
            keyVersion: 1,
            create: true,
            members: keyed.map((member) => ({ userId: member.userId, publicKey: member.publicKey as string })),
          });
        }
        continue;
      }
      const rows = holders.filter((row) => row.collectionId === collection.id);
      const mine = rows.find((row) => row.userId === userId && row.keyVersion === collection.e2eKeyVersion);
      if (!mine) continue;
      const stale = rows.some((row) => !people.some((member) => member.userId === row.userId));
      if (stale) {
        const links = await ItemKey.findAll({
          where: { containerType: "collection", containerId: collection.id },
          attributes: ["noteId", "keyVersion", "wrappedKey"],
        });
        const notes = links.length
          ? await Note.findAll({
              where: { id: { [Op.in]: links.map((link) => link.noteId) } },
              attributes: ["id", "e2eId"],
              paranoid: false,
            })
          : [];
        const e2eIdOf = new Map(notes.map((note) => [note.id, note.e2eId]));
        rotate.push({
          collectionId: collection.id,
          keyVersion: collection.e2eKeyVersion,
          myKey: mine.wrappedKey,
          members: keyed.map((member) => ({ userId: member.userId, publicKey: member.publicKey as string })),
          items: links.map((link) => ({ noteId: link.noteId, e2eId: e2eIdOf.get(link.noteId), wrappedKey: link.wrappedKey })),
          // Encrypted with the old key: encrypted again with the new one.
          ...(collection.encName && collection.nameKey === `v${collection.e2eKeyVersion}` ? { encName: collection.encName } : {}),
        });
        continue;
      }
      const missing = keyed.filter(
        (member) => !rows.some((row) => row.userId === member.userId && row.keyVersion === collection.e2eKeyVersion)
      );
      if (missing.length) {
        grant.push({
          collectionId: collection.id,
          keyVersion: collection.e2eKeyVersion,
          create: false,
          myKey: mine.wrappedKey,
          members: missing.map((member) => ({ userId: member.userId, publicKey: member.publicKey as string })),
        });
      }
    }
    return { encrypt, grant, rotate, names: this.nameTasks(userId, collections, members, holders) };
  }

  /**
   * Collection names in the wrong state, for this person's browser to fix:
   * a collection only its owner can see is encrypted with their user key, an
   * encrypted collection's with its current key, any other stays readable.
   */
  private nameTasks(
    userId: number,
    collections: Collection[],
    members: Map<number, Member[]>,
    holders: CollectionKey[]
  ) {
    const tasks = [];
    for (const collection of collections) {
      const people = members.get(collection.id) || [];
      const mine = holders.find(
        (row) => row.collectionId === collection.id && row.userId === userId && row.keyVersion === collection.e2eKeyVersion
      );
      const privateToOwner = !collection.companyId && collection.userId === userId && people.length === 1;
      const want =
        collection.e2eKeyVersion != null && mine
          ? `v${collection.e2eKeyVersion}`
          : privateToOwner && people[0]?.publicKey
            ? "user"
            : collection.e2eKeyVersion == null
              ? "plain"
              : null;
      const have = collection.encName ? collection.nameKey : "plain";
      if (!want || want === have) continue;
      // Opening the current name needs its key here: the owner's user key, or the current collection key.
      if (have === "user" && collection.userId !== userId) continue;
      if (have && have !== "plain" && have !== "user" && have !== `v${collection.e2eKeyVersion}`) continue;
      tasks.push({
        collectionId: collection.id,
        want,
        ...(collection.encName ? { encName: collection.encName, nameKey: collection.nameKey } : { name: collection.name }),
        ...(mine ? { keyVersion: mine.keyVersion, myKey: mine.wrappedKey } : {}),
      });
    }
    return tasks;
  }

  /**
   * Names fixed in the browser (see nameTasks). Each must match the state the
   * collection should be in now; a readable name must not clash with another.
   */
  async applyNames(userId: number, input: unknown) {
    const list = Array.isArray(input) ? input.slice(0, 200) : [];
    const managed = await this.managedCollections(userId);
    const members = await this.membersOf(managed.map((item) => item.id));
    const holders = managed.length
      ? await CollectionKey.findAll({ where: { collectionId: { [Op.in]: managed.map((item) => item.id) } } })
      : [];
    const wanted = new Map(this.nameTasks(userId, managed, members, holders).map((task) => [task.collectionId, task.want]));
    let updated = 0;
    for (const raw of list as any[]) {
      const collectionId = Number(raw?.collectionId);
      const want = wanted.get(collectionId);
      const collection = managed.find((item) => item.id === collectionId);
      if (!want || !collection) continue;
      if (want === "plain") {
        const name = String(raw?.name || "").trim().slice(0, 100);
        if (!name) continue;
        const clash = await Collection.count({
          where: {
            id: { [Op.ne]: collectionId },
            name,
            ...(collection.companyId ? { companyId: collection.companyId } : { userId: collection.userId, companyId: { [Op.is]: null } }),
          },
        });
        await Collection.update(
          { name: clash ? `${name.slice(0, 90)} (${collectionId})` : name, encName: null, nameKey: null },
          { where: { id: collectionId } }
        );
      } else {
        if (String(raw?.nameKey || "") !== want || !NAME_KEY.test(want)) continue;
        await Collection.update(
          { encName: assertEncName(raw?.encName), nameKey: want, ...(collection.encName ? {} : { name: placeholderName() }) },
          { where: { id: collectionId } }
        );
        // Items no longer carry the readable name as their "project".
        await Note.update({ project: null }, { where: { collectionId }, paranoid: false });
      }
      updated += 1;
    }
    return { updated };
  }

  /**
   * A new collection key after someone lost access: sealed again to everyone
   * who has access now, and every item key in the collection wrapped again.
   * Items aren't re-encrypted; see E2E_DESIGN.md on what this protects.
   */
  async rotate(userId: number, collectionId: number, input: any) {
    const managed = (await this.managedCollections(userId)).some((item) => item.id === collectionId);
    if (!managed) throw httpError("Only an owner or admin can do this.", 403);
    const people = (await this.membersOf([collectionId])).get(collectionId) || [];
    await sequelize.transaction(async (transaction) => {
      const collection = await Collection.findByPk(collectionId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!collection || collection.e2eKeyVersion == null) throw httpError("This collection isn't encrypted.", 409);
      const keyVersion = Number(input?.keyVersion);
      if (keyVersion !== collection.e2eKeyVersion + 1) throw httpError("The collection key changed. Try again.", 409);
      const keys = (Array.isArray(input?.keys) ? input.keys : []).map((key: any) => ({
        userId: Number(key?.userId),
        wrappedKey: assertKey(key?.wrappedKey, SEALED_KEY, "collection key"),
      }));
      const keyed = people.filter((member) => member.publicKey);
      if (
        !keyed.every((member) => keys.some((key: any) => key.userId === member.userId)) ||
        keys.some((key: any) => !people.some((member) => member.userId === key.userId))
      ) {
        throw httpError("The new key must go to exactly the people with access.", 409);
      }
      const links = await ItemKey.findAll({ where: { containerType: "collection", containerId: collectionId }, transaction });
      const items = new Map<number, string>(
        (Array.isArray(input?.items) ? input.items : []).map((item: any) => [
          Number(item?.noteId),
          assertKey(item?.wrappedKey, ITEM_KEY, "item key"),
        ])
      );
      if (!links.every((link) => items.has(link.noteId))) throw httpError("Every item key must be wrapped again.", 409);
      await CollectionKey.destroy({ where: { collectionId }, transaction });
      for (const key of keys) {
        await CollectionKey.create(
          { collectionId, userId: key.userId, keyVersion, wrappedKey: key.wrappedKey, grantedBy: userId },
          { transaction }
        );
      }
      for (const link of links) {
        await link.update({ keyVersion, wrappedKey: items.get(link.noteId) as string }, { transaction });
      }
      // A name under the old key must come re-encrypted with the new one.
      const renamed =
        collection.encName && collection.nameKey === `v${collection.e2eKeyVersion}`
          ? { encName: assertEncName(input?.encName), nameKey: `v${keyVersion}` }
          : {};
      await collection.update({ e2eKeyVersion: keyVersion, ...renamed }, { transaction });
    });
    return { rotated: true };
  }
}

export default new E2EItemService();
