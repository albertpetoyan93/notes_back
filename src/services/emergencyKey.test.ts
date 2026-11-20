import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import EmergencyCollectionName from "@src/models/EmergencyCollectionName";
import EmergencyContact from "@src/models/EmergencyContact";
import EmergencyItemKey from "@src/models/EmergencyItemKey";
import EmergencyKey from "@src/models/EmergencyKey";
import Note from "@src/models/Note";
import User from "@src/models/User";
import CollectionService from "@src/services/CollectionService";
import EmergencyAccessService from "@src/services/EmergencyAccessService";
import EmailService from "@src/services/EmailService";
import EntitlementService from "@src/services/EntitlementService";
import NoteService from "@src/services/NoteService";
import NotificationService from "@src/services/NotificationService";
import { table } from "@src/services/recoveryTestDb";

// Well-formed stand-ins for what browsers send (the server only checks the shape).
const WRAPPED = (n: number) => `e2e1.${"a".repeat(16)}.${String(n).padEnd(64, "b")}`;
const SEALED = (n: number) => `e2e1x.${"c".repeat(43)}.${"d".repeat(16)}.${String(n).padEnd(80, "e")}`;
const PIN = (n: number) => `e2e1.${"p".repeat(16)}.${String(n).padEnd(60, "q")}`;
const NAME = (n: number) => `e2e1.${"f".repeat(16)}.${String(n).padEnd(40, "g")}`;

let db: Record<string, any[]>;

// Olga (1) trusts Pat (2, confirmed with the old user-key copy) and Lu (3, only invited).
// Olga's items: 10 and 11 personal, 12 in Acme's vault (a work item), 13 belongs to Pat.
// Collections: 20 Olga's own, 21 Acme's.
beforeEach(() => {
  db = {
    users: table(User, [
      { id: 1, email: "olga@x.com", e2eEnabled: true, publicKey: "olga-pub" },
      { id: 2, email: "pat@x.com", e2eEnabled: true, publicKey: "pat-pub" },
      { id: 3, email: "lu@x.com", e2eEnabled: true, publicKey: "lu-pub" },
    ]),
    notes: table(Note, [
      { id: 10, userId: 1, e2e: true, e2eId: "e10", companyId: null, itemKey: "uk10" },
      { id: 11, userId: 1, e2e: true, e2eId: "e11", companyId: null, itemKey: "uk11" },
      { id: 12, userId: 1, e2e: true, e2eId: "e12", companyId: null },
      { id: 13, userId: 2, e2e: true, e2eId: "e13", companyId: null },
    ]),
    collections: table(Collection, [
      { id: 20, userId: 1, companyId: null, name: "", encName: "x", nameKey: "user" },
      { id: 21, userId: 1, companyId: 7, name: "", encName: "y" },
    ]),
    contacts: table(EmergencyContact, [
      { id: 5, grantorId: 1, contactId: 2, email: "pat@x.com", status: "confirmed", waitDays: 7, sealedUserKey: SEALED(0), remindersSent: 0 },
      { id: 6, grantorId: 1, contactId: 3, email: "lu@x.com", status: "invited", waitDays: 7, remindersSent: 0 },
    ]),
    keys: table(EmergencyKey, []),
    itemKeys: table(EmergencyItemKey, []),
    names: table(EmergencyCollectionName, []),
  };
  // EmergencyKey's primary key is userId, not id.
  vi.spyOn(EmergencyKey, "findByPk").mockImplementation((async (userId: number) => {
    const row = db.keys.find((key) => key.userId === userId);
    return row ? { ...row, get: (k: string) => row[k] } : null;
  }) as never);
  vi.spyOn(CollectionService, "collectionsByNoteId").mockImplementation((async (ids: number[]) => {
    const map = new Map();
    for (const id of ids) map.set(id, id === 12 ? [{ id: 21, name: "", companyId: 7 }] : id === 11 ? [{ id: 20, name: "", companyId: null }] : []);
    return map;
  }) as never);
  vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
});

afterEach(() => vi.restoreAllMocks());

const firstKey = () =>
  EmergencyAccessService.saveKeys(1, { keyVersion: 1, emergencyKey: WRAPPED(1) });

const copyEverything = () =>
  EmergencyAccessService.saveKeys(1, {
    keyVersion: 1,
    items: [
      { noteId: 10, wrappedKey: WRAPPED(10) },
      { noteId: 11, wrappedKey: WRAPPED(11) },
    ],
    collections: [{ collectionId: 20, encName: NAME(20) }],
  });

describe("emergency key: the owner's background tasks", () => {
  it("no key yet: make one first; then only personal items and collections are listed, no contact yet", async () => {
    expect(await EmergencyAccessService.tasks(1)).toMatchObject({ keyVersion: null, emergencyKey: null, rotate: true, contacts: [] });
    await firstKey();
    const tasks = await EmergencyAccessService.tasks(1);
    // With the owner's own user-key wrap: the browser opens it itself, so it can't be fed a company item's key.
    expect(tasks.items).toEqual([
      { noteId: 10, e2eId: "e10", itemKey: "uk10" },
      { noteId: 11, e2eId: "e11", itemKey: "uk11" },
    ]);
    expect(tasks.collections).toEqual([{ id: 20, name: "", encName: "x", nameKey: "user" }]);
    expect(tasks.contacts).toEqual([]);
  });

  it("no trusted contacts: nothing to make", async () => {
    db.contacts.splice(0, db.contacts.length);
    expect(await EmergencyAccessService.tasks(1)).toMatchObject({ rotate: false, items: [], collections: [], contacts: [] });
  });

  it("a contact on the old user-key copy is never sealed automatically: the owner confirms them again", async () => {
    await firstKey();
    await copyEverything();
    const tasks = await EmergencyAccessService.tasks(1);
    expect(tasks.items).toEqual([]);
    expect(tasks.collections).toEqual([]);
    expect(tasks.contacts).toEqual([]);
    await expect(
      EmergencyAccessService.saveKeys(1, { keyVersion: 1, contacts: [{ id: 5, sealedKey: SEALED(5), pinnedKey: PIN(5) }] })
    ).rejects.toMatchObject({ status: 404 });
    expect(db.contacts.find((row) => row.id === 5)).toMatchObject({ sealedUserKey: SEALED(0) });
  });

  it("confirming an old contact again moves them to the emergency key, keeping their status", async () => {
    await firstKey();
    db.contacts.find((row) => row.id === 5)!.status = "granted";
    await EmergencyAccessService.confirm(1, 5, { sealedEmergencyKey: SEALED(5), keyVersion: 1, pinnedKey: PIN(5) });
    expect(db.contacts.find((row) => row.id === 5)).toMatchObject({
      status: "granted",
      sealedEmergencyKey: SEALED(5),
      emergencyKeyVersion: 1,
      sealedUserKey: null,
      // The contact's key as the owner checked it by fingerprint, under the owner's user key.
      pinnedKey: PIN(5),
    });
    // Already moved: there's nothing to confirm again.
    await expect(
      EmergencyAccessService.confirm(1, 5, { sealedEmergencyKey: SEALED(5), keyVersion: 1, pinnedKey: PIN(5) })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("the owner's page says which contacts to confirm again, with the key to check", async () => {
    vi.spyOn(EntitlementService, "forUser").mockResolvedValue({ limits: { emergencyAccess: true } } as never);
    const { contacts } = await EmergencyAccessService.summary(1);
    expect(contacts.find((row: any) => row.id === 5)).toMatchObject({ needsReconfirm: true, publicKey: "pat-pub" });
    expect(contacts.find((row: any) => row.id === 6)).toMatchObject({ needsReconfirm: false, publicKey: null });
  });

  it("a second tab making the first key too: refused, the first one stands", async () => {
    await firstKey();
    await expect(EmergencyAccessService.saveKeys(1, { keyVersion: 1, emergencyKey: WRAPPED(99) })).rejects.toMatchObject({ status: 409 });
    expect(db.keys).toHaveLength(1);
    expect(db.keys[0].wrappedKey).toBe(WRAPPED(1));
  });

  it("refuses copies of items that aren't personal, and copies at another version", async () => {
    await firstKey();
    await expect(
      EmergencyAccessService.saveKeys(1, { keyVersion: 1, items: [{ noteId: 12, wrappedKey: WRAPPED(12) }] })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      EmergencyAccessService.saveKeys(1, { keyVersion: 1, items: [{ noteId: 13, wrappedKey: WRAPPED(13) }] })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      EmergencyAccessService.saveKeys(1, { keyVersion: 2, items: [{ noteId: 10, wrappedKey: WRAPPED(10) }] })
    ).rejects.toMatchObject({ status: 409 });
    expect(db.itemKeys).toHaveLength(0);
  });

  it("the same copy twice (two tabs) is fine", async () => {
    await firstKey();
    await copyEverything();
    await copyEverything();
    expect(db.itemKeys).toHaveLength(2);
  });

  it("an item that moved into a company loses its copy", async () => {
    await firstKey();
    await copyEverything();
    db.notes.find((note) => note.id === 10)!.companyId = 7;
    await EmergencyAccessService.tasks(1);
    expect(db.itemKeys.map((row) => row.noteId)).toEqual([11]);
  });
});

describe("emergency key: confirming a contact", () => {
  beforeEach(() => {
    db.contacts.find((row) => row.id === 6)!.status = "accepted";
  });

  it("an old app sending the user key is told to reload", async () => {
    await expect(EmergencyAccessService.confirm(1, 6, { sealedUserKey: SEALED(6) })).rejects.toMatchObject({
      status: 409,
      message: "Reload 2keevo and confirm again.",
    });
  });

  it("the emergency key at the current version confirms them", async () => {
    await firstKey();
    await EmergencyAccessService.confirm(1, 6, { sealedEmergencyKey: SEALED(6), keyVersion: 1, pinnedKey: PIN(6) });
    expect(db.contacts.find((row) => row.id === 6)).toMatchObject({
      status: "confirmed",
      sealedEmergencyKey: SEALED(6),
      emergencyKeyVersion: 1,
      pinnedKey: PIN(6),
    });
  });

  it("an out-of-date version is refused", async () => {
    await firstKey();
    await expect(EmergencyAccessService.confirm(1, 6, { sealedEmergencyKey: SEALED(6), keyVersion: 2 })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("emergency key: the contact's vault", () => {
  const grantPat = () => Object.assign(db.contacts.find((row) => row.id === 5)!, { status: "granted", grantedAt: new Date() });

  it("upgraded: only the emergency key and copies; never the user key, private key or item keys", async () => {
    await firstKey();
    await EmergencyAccessService.saveKeys(1, {
      keyVersion: 1,
      items: [{ noteId: 10, wrappedKey: WRAPPED(10) }],
      collections: [{ collectionId: 20, encName: NAME(20) }],
    });
    Object.assign(db.contacts.find((row) => row.id === 5)!, { sealedEmergencyKey: SEALED(5), emergencyKeyVersion: 1, sealedUserKey: null });
    Object.assign(db.notes.find((note) => note.id === 10)!, { encData: "data10", category: "login", itemKey: "user-wrapped" });
    Object.assign(db.notes.find((note) => note.id === 11)!, { encData: "data11", category: "note", itemKey: "user-wrapped" });
    grantPat();

    const vault: any = await EmergencyAccessService.vault(2, 5);
    expect(vault).toMatchObject({ scheme: "emergency-key", keyVersion: 1, sealedKey: SEALED(5), waiting: 1 });
    expect(vault.items).toEqual([{ e2eId: "e10", emergencyKey: WRAPPED(10), encData: "data10", category: "login", collectionIds: [] }]);
    expect(vault.collections).toEqual([{ id: 20, name: null, encName: NAME(20) }]);
    const text = JSON.stringify(vault);
    for (const forbidden of ["sealedUserKey", "protectedPrivateKey", "publicKey", "itemKey", "user-wrapped"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("not upgraded yet: the old copy still works as before", async () => {
    grantPat();
    vi.spyOn(NoteService, "exportNotes").mockResolvedValue({ notes: [] } as never);
    table(CollectionKey, []);
    const vault: any = await EmergencyAccessService.vault(2, 5);
    expect(vault).toMatchObject({ scheme: "user-key", sealedUserKey: SEALED(0) });
  });

  it("no access, no vault", async () => {
    await expect(EmergencyAccessService.vault(2, 5)).rejects.toMatchObject({ status: 403 });
  });
});

describe("emergency key: a new one after access ends", () => {
  const ready = async () => {
    await firstKey();
    await copyEverything();
    await EmergencyAccessService.confirm(1, 5, { sealedEmergencyKey: SEALED(5), keyVersion: 1, pinnedKey: PIN(5) });
  };
  const rotateFlag = () => db.keys.find((key) => key.userId === 1)?.rotate;

  it("removing a contact who had access asks for a new key", async () => {
    await ready();
    db.contacts.find((row) => row.id === 5)!.status = "granted";
    await EmergencyAccessService.remove(1, 5);
    expect(rotateFlag()).toBe(true);
    expect(await EmergencyAccessService.tasks(1)).toMatchObject({ rotate: true, keyVersion: 1 });
  });

  it("ending granted access, or the contact leaving after it, asks for a new key too", async () => {
    await ready();
    db.contacts.find((row) => row.id === 5)!.status = "granted";
    vi.spyOn(EmailService, "sendEmergencyRefused").mockResolvedValue(true as never);
    await EmergencyAccessService.refuse(1, 5);
    expect(rotateFlag()).toBe(true);

    db.keys[0].rotate = false;
    db.contacts.find((row) => row.id === 5)!.status = "granted";
    await EmergencyAccessService.leave(2, 5);
    expect(rotateFlag()).toBe(true);
  });

  it("removing a contact who never had access doesn't", async () => {
    await ready();
    await EmergencyAccessService.remove(1, 5);
    expect(rotateFlag()).toBe(false);
  });

  it("the new key: version 2, every item is listed to be copied again", async () => {
    await ready();
    db.contacts.push({ id: 7, grantorId: 1, contactId: 3, email: "lu@x.com", status: "granted", waitDays: 7, remindersSent: 0 });
    await EmergencyAccessService.remove(1, 7);
    await EmergencyAccessService.saveKeys(1, { keyVersion: 2, emergencyKey: WRAPPED(2) });
    const tasks = await EmergencyAccessService.tasks(1);
    expect(tasks).toMatchObject({ keyVersion: 2, rotate: false });
    expect(tasks.items).toHaveLength(2);
  });
});

describe("emergency key: mid review fixes", () => {
  it("after a new key, a contact already on the emergency key is sealed again at once, even with items left; old copies stay until then", async () => {
    await firstKey();
    await copyEverything();
    await EmergencyAccessService.confirm(1, 5, { sealedEmergencyKey: SEALED(5), keyVersion: 1, pinnedKey: PIN(5) });
    db.contacts.push({ id: 7, grantorId: 1, contactId: 3, email: "lu@x.com", status: "granted", waitDays: 7, remindersSent: 0 });
    await EmergencyAccessService.remove(1, 7);
    await EmergencyAccessService.saveKeys(1, { keyVersion: 2, emergencyKey: WRAPPED(2) });

    // Pat still holds version 1: its copies stay, so Pat's vault isn't emptied meanwhile.
    expect(db.itemKeys.map((row) => row.keyVersion)).toEqual([1, 1]);
    // Only item 10 can be copied this time (11 fails in the browser): Pat is sealed again anyway.
    await EmergencyAccessService.saveKeys(1, { keyVersion: 2, items: [{ noteId: 10, wrappedKey: WRAPPED(10) }] });
    const tasks = await EmergencyAccessService.tasks(1);
    expect(tasks.items.map((item) => item.noteId)).toEqual([11]);
    expect(tasks.contacts).toEqual([{ id: 5, publicKey: "pat-pub", pinnedKey: PIN(5) }]);

    await EmergencyAccessService.saveKeys(1, { keyVersion: 2, contacts: [{ id: 5, sealedKey: SEALED(55) }] });
    await EmergencyAccessService.tasks(1);
    // Nobody holds version 1 any more: its copies go.
    expect(db.itemKeys.map((row) => row.keyVersion)).toEqual([2]);
  });

  it("ending granted access: they must be confirmed again before they get any new key", async () => {
    await firstKey();
    await EmergencyAccessService.confirm(1, 5, { sealedEmergencyKey: SEALED(5), keyVersion: 1, pinnedKey: PIN(5) });
    db.contacts.find((row) => row.id === 5)!.status = "granted";
    vi.spyOn(EmailService, "sendEmergencyRefused").mockResolvedValue(true as never);
    await EmergencyAccessService.refuse(1, 5);
    expect(db.contacts.find((row) => row.id === 5)).toMatchObject({
      status: "accepted",
      sealedEmergencyKey: null,
      emergencyKeyVersion: null,
      pinnedKey: null,
    });
    await EmergencyAccessService.saveKeys(1, { keyVersion: 2, emergencyKey: WRAPPED(2) });
    expect((await EmergencyAccessService.tasks(1)).contacts).toEqual([]);
  });

  it("refusing a request that wasn't granted yet keeps them a ready contact", async () => {
    await firstKey();
    await EmergencyAccessService.confirm(1, 5, { sealedEmergencyKey: SEALED(5), keyVersion: 1, pinnedKey: PIN(5) });
    db.contacts.find((row) => row.id === 5)!.status = "requested";
    vi.spyOn(EmailService, "sendEmergencyRefused").mockResolvedValue(true as never);
    await EmergencyAccessService.refuse(1, 5);
    expect(db.contacts.find((row) => row.id === 5)).toMatchObject({ status: "confirmed", sealedEmergencyKey: SEALED(5) });
  });

  it("lists at most 500 items at a time", async () => {
    for (let i = 0; i < 600; i++) db.notes.push({ id: 1000 + i, userId: 1, e2e: true, e2eId: `x${i}`, companyId: null, itemKey: "k" });
    await firstKey();
    expect((await EmergencyAccessService.tasks(1)).items).toHaveLength(500);
  });

  it("another owner's copy of the same note doesn't count as this owner's", async () => {
    await firstKey();
    db.itemKeys.push({ id: 99, grantorId: 2, noteId: 10, keyVersion: 1, wrappedKey: WRAPPED(0) });
    await EmergencyAccessService.saveKeys(1, { keyVersion: 1, items: [{ noteId: 10, wrappedKey: WRAPPED(10) }] });
    expect(db.itemKeys.filter((row) => row.grantorId === 1)).toHaveLength(1);
  });

  it("no contacts left: the copies go", async () => {
    await firstKey();
    await copyEverything();
    db.contacts.splice(0, db.contacts.length);
    await EmergencyAccessService.tasks(1);
    expect(db.itemKeys).toEqual([]);
    expect(db.names).toEqual([]);
  });
});
