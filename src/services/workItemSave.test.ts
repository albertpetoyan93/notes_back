import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Note from "@src/models/Note";
import Collection from "@src/models/Collection";
import CollectionNote from "@src/models/CollectionNote";
import NoteShare from "@src/models/NoteShare";
import sequelize from "@src/configs/DB/sequelize";
import CollectionService from "@src/services/CollectionService";
import E2EItemService from "@src/services/E2EItemService";
import AuditService from "@src/services/AuditService";
import NoteService, { canManage } from "@src/services/NoteService";
import OffboardingService from "@src/services/OffboardingService";

const E2E_ID = "a".repeat(22);
const ITEM_KEY = `e2e1.${"b".repeat(16)}.${"c".repeat(43)}`;
const ENC_DATA = `e2e1.${"d".repeat(16)}.${"e".repeat(30)}`;

// Collections 1 and 2 belong to company 7; collection 9 is personal.
const COLLECTIONS: Record<number, number | null> = { 1: 7, 2: 7, 9: null };

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

function fakeNote(fields: Record<string, unknown>) {
  const note = { id: 5, userId: 3, e2e: false, companyId: null, updatedAt: new Date(), ...fields } as any;
  note.update = vi.fn(async () => note);
  note.toJSON = () => ({ ...note });
  return note;
}

beforeEach(() => {
  vi.spyOn(Collection, "findAll").mockImplementation((async (options: any) => {
    const ids: number[] = Object.getOwnPropertySymbols(options.where.id)
      .map((symbol) => options.where.id[symbol])
      .flat();
    return ids.filter((id) => id in COLLECTIONS).map((id) => ({ id, companyId: COLLECTIONS[id] }));
  }) as never);
  vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({ LOCK: { UPDATE: "UPDATE" } })) as never);
  vi.spyOn(CollectionService, "assertCanAdd").mockResolvedValue({ collection: { id: 1 } } as never);
  vi.spyOn(CollectionService, "setNoteCollections").mockResolvedValue(undefined as never);
  vi.spyOn(CollectionService, "collectionsByNoteId").mockResolvedValue(new Map() as never);
  vi.spyOn(CollectionService, "openCompanyCollections").mockResolvedValue(new Map() as never);
  vi.spyOn(E2EItemService, "ensureNew").mockResolvedValue([] as never);
  vi.spyOn(E2EItemService, "ensure").mockResolvedValue(undefined as never);
  vi.spyOn(E2EItemService, "coversCollections").mockResolvedValue(true as never);
  vi.spyOn(E2EItemService, "keyPathsFor").mockResolvedValue(new Map() as never);
  vi.spyOn(AuditService, "record").mockResolvedValue(undefined as never);
  vi.spyOn(Note, "create").mockResolvedValue(fakeNote({}) as never);
  vi.spyOn(Note, "findByPk").mockResolvedValue(null as never);
  vi.spyOn(NoteService as any, "getFavoriteNoteIds").mockResolvedValue(new Set());
  vi.spyOn(NoteService as any, "keepVersion").mockResolvedValue(undefined);
  vi.spyOn(NoteService as any, "keepSealedVersion").mockResolvedValue(undefined);
  vi.spyOn(NoteService as any, "assertPasswordRule").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("creating a work item", () => {
  it("refuses an end-to-end company item that carries a personal key copy", async () => {
    const err = await failure(
      NoteService.createNote(3, {
        title: "",
        content: {},
        category: "login",
        collectionIds: [1],
        e2e: { e2eId: E2E_ID, itemKey: ITEM_KEY, encData: ENC_DATA },
      })
    );
    expect(err.status).toBe(400);
    expect(err.message).toBe("Update 2keevo: company items are saved without a personal key copy.");
    expect(E2EItemService.ensureNew).not.toHaveBeenCalled();
    expect(Note.create).not.toHaveBeenCalled();
  });

  it("refuses a mix of personal and company collections", async () => {
    const err = await failure(
      NoteService.createNote(3, { title: "x", content: {}, category: "note", collectionIds: [1, 9] })
    );
    expect(err.status).toBe(400);
    expect(Note.create).not.toHaveBeenCalled();
  });

  it("saves an end-to-end company item without a creator copy, owned by the company", async () => {
    await NoteService.createNote(3, {
      title: "",
      content: {},
      category: "login",
      collectionIds: [1],
      e2e: { e2eId: E2E_ID, encData: ENC_DATA } as any,
    });
    expect(Note.create).toHaveBeenCalledWith(expect.objectContaining({ companyId: 7, itemKey: null, e2e: true }), expect.anything());
  });

  it("stores the item, its links and its key copies in one transaction: a failing key copy leaves no item", async () => {
    const TX = { LOCK: { UPDATE: "UPDATE" }, id: "create-tx" };
    let rolledBack = false;
    vi.mocked(sequelize.transaction).mockImplementation((async (fn: any) => {
      try {
        return await fn(TX);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    }) as never);
    vi.mocked(E2EItemService.ensureNew).mockResolvedValue([{ collectionId: 1, keyVersion: 1, wrappedKey: ITEM_KEY }] as never);
    vi.spyOn(E2EItemService, "storeNewItemKeys").mockRejectedValue(new Error("db down"));
    await expect(
      NoteService.createNote(3, {
        title: "",
        content: {},
        category: "login",
        collectionIds: [1],
        e2e: { e2eId: E2E_ID, encData: ENC_DATA } as any,
      })
    ).rejects.toThrow("db down");
    expect(Note.create).toHaveBeenCalledWith(expect.objectContaining({ companyId: 7 }), { transaction: TX });
    expect(CollectionService.setNoteCollections).toHaveBeenCalledWith(5, [1], TX);
    expect(E2EItemService.storeNewItemKeys).toHaveBeenCalledWith(5, expect.any(Array), TX);
    expect(rolledBack).toBe(true);
  });

  it("marks a readable item in a company collection as the company's", async () => {
    await NoteService.createNote(3, { title: "x", content: {}, category: "note", collectionIds: [2] });
    expect(Note.create).toHaveBeenCalledWith(expect.objectContaining({ companyId: 7 }));
  });

  it("keeps a readable personal item personal", async () => {
    await NoteService.createNote(3, { title: "x", content: {}, category: "note", collectionIds: [9] });
    expect(Note.create).toHaveBeenCalledWith(expect.objectContaining({ companyId: null }));
  });

  it("names the rule when personal and company collections are mixed", async () => {
    const err = await failure(
      NoteService.createNote(3, { title: "x", content: {}, category: "note", collectionIds: [9, 2] })
    );
    expect(err.message).toBe("A company item can only be in that company's collections.");
  });

  it("keeps a personal item personal, with its creator copy", async () => {
    await NoteService.createNote(3, {
      title: "",
      content: {},
      category: "login",
      collectionIds: [9],
      e2e: { e2eId: E2E_ID, itemKey: ITEM_KEY, encData: ENC_DATA },
    });
    expect(Note.create).toHaveBeenCalledWith(expect.objectContaining({ companyId: null, itemKey: ITEM_KEY }), expect.anything());
  });
});

describe("changing a work item's collections", () => {
  it("moves a personal end-to-end item into a company and drops the creator copy", async () => {
    const note = fakeNote({ e2e: true, itemKey: ITEM_KEY });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "owner" } as never);
    await NoteService.updateNote(5, 3, { collectionIds: [1], encData: ENC_DATA });
    expect(E2EItemService.ensure).toHaveBeenCalled();
    expect(note.update).toHaveBeenCalledWith({ companyId: 7, itemKey: null }, expect.anything());
    expect(CollectionService.setNoteCollections).toHaveBeenCalledWith(5, [1], expect.anything());
    expect(AuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "item_moved_to_company", noteId: 5, companyId: 7 })
    );
  });

  it("refuses (and keeps the creator copy) when a collection copy is missing", async () => {
    vi.mocked(E2EItemService.coversCollections).mockResolvedValue(false as never);
    const note = fakeNote({ e2e: true, itemKey: ITEM_KEY });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "owner" } as never);
    const err = (await failure(NoteService.updateNote(5, 3, { collectionIds: [1] }))) as any;
    expect(err.status).toBe(409);
    expect(err.message).toBe("A key for one of the collections is missing. Try again.");
    expect(note.update).not.toHaveBeenCalledWith(expect.objectContaining({ itemKey: null }), expect.anything());
    expect(AuditService.record).not.toHaveBeenCalled();
  });

  it("doesn't re-check the copies when a work item joins another company collection", async () => {
    vi.mocked(E2EItemService.coversCollections).mockResolvedValue(false as never);
    const note = fakeNote({ e2e: true, companyId: 7, itemKey: null });
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
    );
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "edit" } as never);
    vi.spyOn(CollectionService, "getAccess").mockResolvedValue({ permission: "edit" } as never);
    await NoteService.updateNote(5, 3, { collectionIds: [1, 2] });
    expect(E2EItemService.coversCollections).not.toHaveBeenCalled();
    expect(CollectionService.setNoteCollections).toHaveBeenCalledWith(5, [1, 2], expect.anything());
  });

  it("keeps the creator copy when linking the collections fails", async () => {
    vi.mocked(CollectionService.setNoteCollections).mockRejectedValue(new Error("db down"));
    const note = fakeNote({ e2e: true, itemKey: ITEM_KEY });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "owner" } as never);
    await expect(NoteService.updateNote(5, 3, { collectionIds: [1] })).rejects.toThrow("db down");
    const calls: Record<string, unknown>[] = note.update.mock.calls.map((call: any[]) => call[0]);
    expect(calls.some((fields) => "itemKey" in fields || "companyId" in fields)).toBe(false);
    expect(AuditService.record).not.toHaveBeenCalled();
  });

  it("refuses to move a work item to another company", async () => {
    COLLECTIONS[3] = 8;
    const note = fakeNote({ e2e: true, companyId: 7 });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "edit" } as never);
    const err = await failure(NoteService.updateNote(5, 4, { collectionIds: [3] }));
    delete COLLECTIONS[3];
    expect(err.status).toBe(400);
    expect(err.message).toBe("An item can belong to only one company.");
    expect(CollectionService.setNoteCollections).not.toHaveBeenCalled();
  });

  it("moves a readable personal item into a company", async () => {
    const note = fakeNote({});
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "owner" } as never);
    await NoteService.updateNote(5, 3, { collectionIds: [1] });
    expect(note.update).toHaveBeenCalledWith({ companyId: 7 }, expect.anything());
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: "item_moved_to_company" }));
  });

  it("refuses to take a work item out of its company", async () => {
    const note = fakeNote({ e2e: true, companyId: 7 });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "edit" } as never);
    const err = await failure(NoteService.updateNote(5, 4, { collectionIds: [] }));
    expect(err.status).toBe(409);
    expect(err.message).toBe("A company item stays in the company. Copy it to your personal vault instead.");
    expect(CollectionService.setNoteCollections).not.toHaveBeenCalled();
    expect(note.update).not.toHaveBeenCalled();
  });

  it("refuses to take a readable work item out of its company", async () => {
    const note = fakeNote({ companyId: 7 });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "edit" } as never);
    const err = await failure(NoteService.updateNote(5, 4, { collectionIds: [9] }));
    expect(err.status).toBe(409);
    expect(CollectionService.setNoteCollections).not.toHaveBeenCalled();
    expect(note.update).not.toHaveBeenCalled();
  });

  it("lets an editor move a work item between its company's collections", async () => {
    const note = fakeNote({ e2e: true, companyId: 7 });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "edit" } as never);
    await NoteService.updateNote(5, 4, { collectionIds: [2] });
    expect(CollectionService.setNoteCollections).toHaveBeenCalledWith(5, [2], expect.anything());
    expect(AuditService.record).not.toHaveBeenCalled();
  });

  it("still lets only the owner change a personal item's collections", async () => {
    const note = fakeNote({ e2e: true });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "edit" } as never);
    await NoteService.updateNote(5, 4, { collectionIds: [1] });
    expect(CollectionService.setNoteCollections).not.toHaveBeenCalled();
  });
});

describe("canManage", () => {
  it("is the owner for a personal item and an editor for a work item", () => {
    expect(canManage({ note: { companyId: null, userId: 3 }, permission: "owner" }, 3)).toBe(true);
    expect(canManage({ note: { companyId: null, userId: 3 }, permission: "edit" }, 4)).toBe(false);
    expect(canManage({ note: { companyId: 7, userId: 3 }, permission: "edit" }, 4)).toBe(true);
    expect(canManage({ note: { companyId: 7, userId: 3 }, permission: "view" }, 4)).toBe(false);
    // getNoteAccess never answers "owner" for a work item, so it doesn't count.
    expect(canManage({ note: { companyId: 7, userId: 3 }, permission: "owner" }, 3)).toBe(false);
  });
});

describe("moving many items at once", () => {
  // The caller can edit company 7's collection 1, where work item 5 sits.
  function editorOfWorkItem() {
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
    );
    vi.mocked(CollectionService.openCompanyCollections).mockResolvedValue(new Map([[1, "edit"]]) as never);
    vi.spyOn(CollectionService, "activeCompanyIds").mockResolvedValue(new Set([7]) as never);
    vi.spyOn(NoteShare, "findAll").mockResolvedValue([] as never);
  }

  it("refuses to take a work item out of its company", async () => {
    editorOfWorkItem();
    vi.spyOn(Note, "findAll").mockResolvedValue([fakeNote({ e2e: true, companyId: 7 })] as never);
    const err = await failure(NoteService.bulkUpdate(3, [5], "move", null));
    expect(err.status).toBe(409);
    expect(err.message).toBe("A company item stays in the company. Copy it to your personal vault instead.");
    expect(E2EItemService.ensure).not.toHaveBeenCalled();
    expect(CollectionService.setNoteCollections).not.toHaveBeenCalled();
  });

  it("moves a personal item into a company and drops the creator copy", async () => {
    const note = fakeNote({ e2e: true, itemKey: ITEM_KEY });
    vi.spyOn(Note, "findAll").mockResolvedValue([note] as never);
    await NoteService.bulkUpdate(3, [5], "move", 1);
    expect(CollectionService.setNoteCollections).toHaveBeenCalledWith(5, [1], expect.anything());
    expect(note.update).toHaveBeenCalledWith({ companyId: 7, itemKey: null }, expect.anything());
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: "item_moved_to_company" }));
  });

  it("refuses a target in another company", async () => {
    COLLECTIONS[3] = 8;
    editorOfWorkItem();
    vi.mocked(CollectionService.assertCanAdd).mockResolvedValue({ collection: { id: 3 } } as never);
    vi.spyOn(Note, "findAll").mockResolvedValue([fakeNote({ e2e: true, companyId: 7 })] as never);
    const err = await failure(NoteService.bulkUpdate(3, [5], "move", 3));
    delete COLLECTIONS[3];
    expect(err.status).toBe(400);
    expect(CollectionService.setNoteCollections).not.toHaveBeenCalled();
  });
});

describe("adding items to a collection", () => {
  beforeEach(() => {
    vi.mocked(CollectionService.assertCanAdd).mockResolvedValue({ collection: { id: 1, name: "Team" } } as never);
    vi.spyOn(CollectionService, "addNoteToCollection").mockResolvedValue(undefined as never);
  });

  it("refuses to add a personal item that sits in a personal collection", async () => {
    vi.spyOn(Note, "findAll").mockResolvedValue([fakeNote({ e2e: true })] as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 9, name: "Mine", companyId: null }]]]) as never
    );
    const err = await failure(CollectionService.addNotes(1, 3, [5]));
    expect(err.status).toBe(400);
    expect(CollectionService.addNoteToCollection).not.toHaveBeenCalled();
  });

  it("refuses to add another company's item", async () => {
    COLLECTIONS[3] = 8;
    vi.spyOn(Note, "findAll").mockResolvedValue([fakeNote({ e2e: true, companyId: 8 })] as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 3, name: "Other", companyId: 8 }]]]) as never
    );
    vi.mocked(CollectionService.openCompanyCollections).mockResolvedValue(new Map([[3, "edit"]]) as never);
    const err = await failure(CollectionService.addNotes(1, 3, [5]));
    delete COLLECTIONS[3];
    expect(err.status).toBe(400);
    expect(err.message).toBe("An item can belong to only one company.");
    expect(CollectionService.addNoteToCollection).not.toHaveBeenCalled();
  });

  it("moves a personal item into the company and drops the creator copy", async () => {
    const note = fakeNote({ e2e: true, itemKey: ITEM_KEY });
    vi.spyOn(Note, "findAll").mockResolvedValue([note] as never);
    await CollectionService.addNotes(1, 3, [5]);
    expect(E2EItemService.ensure).toHaveBeenCalledWith(3, [5], undefined, {
      collectionsByNote: new Map([[5, [1]]]),
    });
    expect(CollectionService.addNoteToCollection).toHaveBeenCalledWith(5, 1, "Team", expect.anything());
    expect(note.update).toHaveBeenCalledWith({ companyId: 7, itemKey: null }, expect.anything());
    expect(AuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "item_moved_to_company", noteId: 5, companyId: 7 })
    );
  });

  it("adds a work item to another collection of its company without a move", async () => {
    const note = fakeNote({ e2e: true, companyId: 7 });
    vi.spyOn(Note, "findAll").mockResolvedValue([note] as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 2, name: "Ops", companyId: 7 }]]]) as never
    );
    vi.mocked(CollectionService.openCompanyCollections).mockResolvedValue(new Map([[2, "edit"]]) as never);
    await CollectionService.addNotes(1, 3, [5]);
    expect(CollectionService.addNoteToCollection).toHaveBeenCalled();
    expect(note.update).not.toHaveBeenCalled();
    expect(AuditService.record).not.toHaveBeenCalled();
  });

  it("lets an editor who didn't make a work item add it, but not its view-only creator", async () => {
    vi.spyOn(Note, "findAll").mockResolvedValue([fakeNote({ e2e: true, companyId: 7 })] as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 2, name: "Ops", companyId: 7 }]]]) as never
    );
    vi.mocked(CollectionService.openCompanyCollections).mockResolvedValue(new Map([[2, "view"]]) as never);
    const err = await failure(CollectionService.addNotes(1, 3, [5]));
    expect(err.status).toBe(400);
    expect(CollectionService.addNoteToCollection).not.toHaveBeenCalled();
    vi.mocked(CollectionService.openCompanyCollections).mockResolvedValue(new Map([[2, "edit"]]) as never);
    await CollectionService.addNotes(1, 4, [5]);
    expect(CollectionService.addNoteToCollection).toHaveBeenCalled();
  });
});

describe("removing an item from a collection", () => {
  beforeEach(() => {
    vi.spyOn(CollectionService, "getAccess").mockResolvedValue({ collection: { id: 1 }, permission: "owner" } as never);
    vi.spyOn(CollectionNote, "findOne").mockResolvedValue({} as never);
    vi.spyOn(CollectionNote, "destroy").mockResolvedValue(1 as never);
    vi.spyOn(E2EItemService, "dropItemKey").mockResolvedValue(undefined as never);
  });

  it("refuses to take a work item out of its last company collection", async () => {
    vi.mocked(Note.findByPk).mockResolvedValue(fakeNote({ e2e: true, companyId: 7 }) as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
    );
    const err = await failure(CollectionService.removeNote(1, 3, 5));
    expect(err.status).toBe(409);
    expect(err.message).toBe("A company item stays in the company. Copy it to your personal vault instead.");
    expect(CollectionNote.destroy).not.toHaveBeenCalled();
  });

  it("removes it when another company collection still holds it", async () => {
    vi.mocked(Note.findByPk).mockResolvedValue(fakeNote({ e2e: true, companyId: 7 }) as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }, { id: 2, name: "Ops", companyId: 7 }]]]) as never
    );
    expect(await CollectionService.removeNote(1, 3, 5)).toBe(true);
    expect(CollectionNote.destroy).toHaveBeenCalled();
  });

  it("doesn't let a view-only creator take a work item out of a collection", async () => {
    vi.mocked(CollectionService.getAccess).mockResolvedValue({ collection: { id: 1 }, permission: "view" } as never);
    vi.mocked(Note.findByPk).mockResolvedValue(fakeNote({ e2e: true, companyId: 7 }) as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }, { id: 2, name: "Ops", companyId: 7 }]]]) as never
    );
    expect(await CollectionService.removeNote(1, 3, 5)).toBe(false);
    expect(CollectionNote.destroy).not.toHaveBeenCalled();
  });
});

describe("deleting a company collection", () => {
  const STRANDED =
    "This collection holds company items that are in no other company collection. Move them to another company collection or delete them first.";
  let collection: any;

  beforeEach(() => {
    collection = { id: 1, companyId: 7, destroy: vi.fn() };
    // ADR-002: deleting a company vault is managing it (owners and admins), not opening it.
    vi.spyOn(CollectionService as any, "administers").mockResolvedValue({ collection });
    vi.spyOn(CollectionNote, "findAll").mockResolvedValue([{ noteId: 5 }] as never);
    vi.spyOn(Note, "findAll").mockResolvedValue([{ id: 5 }] as never);
    vi.spyOn(CollectionNote, "destroy").mockResolvedValue(1 as never);
    vi.spyOn(Note, "update").mockResolvedValue([1] as never);
    vi.spyOn(CollectionService as any, "restorePrimaryCollection").mockResolvedValue(undefined);
    vi.spyOn(E2EItemService, "dropCollection").mockResolvedValue(undefined as never);
  });

  it("refuses while it is a work item's only company collection", async () => {
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
    );
    const err = await failure(CollectionService.remove(1, 3));
    expect(err.status).toBe(409);
    expect(err.message).toBe(STRANDED);
    expect(CollectionNote.destroy).not.toHaveBeenCalled();
    expect(collection.destroy).not.toHaveBeenCalled();
  });

  it("refuses while it is the only company collection of an item linked by the old column", async () => {
    // No link row: only the legacy notes.collectionId points here.
    vi.mocked(CollectionNote.findAll).mockResolvedValue([] as never);
    vi.mocked(Note.findAll).mockImplementation((async (options: any) =>
      options.where.collectionId || options.paranoid === false ? [{ id: 5, collectionId: 1 }] : []) as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
    );
    const err = await failure(CollectionService.remove(1, 3));
    expect(err.status).toBe(409);
    expect(err.message).toBe(STRANDED);
    expect(collection.destroy).not.toHaveBeenCalled();
  });

  it("finishes open offboardings once the collection and its key copies are gone", async () => {
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }, { id: 2, name: "Ops", companyId: 7 }]]]) as never
    );
    const complete = vi.spyOn(OffboardingService, "completeOpenFor").mockResolvedValue(undefined as never);
    expect(await CollectionService.remove(1, 3)).toBe(true);
    expect(complete).toHaveBeenCalledWith(7, 3);
    expect(vi.mocked(E2EItemService.dropCollection).mock.invocationCallOrder[0]).toBeLessThan(
      complete.mock.invocationCallOrder[0]
    );
  });

  it("refuses while it is a trashed work item's only company collection", async () => {
    // Only a lookup that includes trashed items finds this one.
    vi.mocked(Note.findAll).mockImplementation((async (options: any) =>
      options.paranoid === false ? [{ id: 5 }] : []) as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
    );
    const err = await failure(CollectionService.remove(1, 3));
    expect(err.status).toBe(409);
    expect(err.message).toBe(STRANDED);
    expect(collection.destroy).not.toHaveBeenCalled();
  });

  it("deletes it when every work item sits in another company collection too", async () => {
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }, { id: 2, name: "Ops", companyId: 7 }]]]) as never
    );
    expect(await CollectionService.remove(1, 3)).toBe(true);
    expect(collection.destroy).toHaveBeenCalled();
  });
});

describe("items in company collections without a companyId (left by the backfill)", () => {
  const legacy = () => fakeNote({ e2e: false, companyId: null, title: "x", content: {}, tags: [] });

  it("canManage takes the work flag: an editor manages one, its creator alone doesn't", () => {
    expect(canManage({ note: { companyId: null, userId: 3 }, permission: "edit", work: true }, 4)).toBe(true);
    expect(canManage({ note: { companyId: null, userId: 3 }, permission: "owner", work: true }, 3)).toBe(false);
    expect(canManage({ note: { companyId: null, userId: 3 }, permission: "owner" }, 3)).toBe(true);
  });

  it("an editor can change its collections, and it gets the one company it is in", async () => {
    const note = legacy();
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
    );
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "edit", work: true } as never);
    vi.spyOn(CollectionService, "getAccess").mockResolvedValue({ permission: "edit" } as never);
    await NoteService.updateNote(5, 4, { collectionIds: [1, 2] });
    expect(CollectionService.setNoteCollections).toHaveBeenCalledWith(5, [1, 2], expect.anything());
    expect(note.update).toHaveBeenCalledWith({ companyId: 7 }, expect.anything());
  });

  it("can't be moved out of the company", async () => {
    const note = legacy();
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
    );
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "edit", work: true } as never);
    vi.spyOn(CollectionService, "getAccess").mockResolvedValue({ permission: "edit" } as never);
    const err = await failure(NoteService.updateNote(5, 4, { collectionIds: [9] }));
    expect(err.status).toBe(409);
    expect(CollectionService.setNoteCollections).not.toHaveBeenCalled();
  });

  describe("removing it from one collection", () => {
    const setup = (collections: { id: number; companyId: number | null }[]) => {
      const note = legacy();
      vi.spyOn(CollectionService, "getAccess").mockResolvedValue({ permission: "edit" } as never);
      vi.mocked(Note.findByPk).mockResolvedValue(note as never);
      vi.spyOn(CollectionNote, "findOne").mockResolvedValue({} as never);
      vi.spyOn(CollectionNote, "destroy").mockResolvedValue(1 as never);
      vi.spyOn(E2EItemService, "dropItemKey").mockResolvedValue(undefined as never);
      vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
        new Map([[5, collections.map((item) => ({ ...item, name: "" }))]]) as never
      );
      return note;
    };

    it("gives it its company once it is in one company only", async () => {
      const note = setup([{ id: 1, companyId: 7 }, { id: 60, companyId: 8 }]);
      expect(await CollectionService.removeNote(60, 4, 5)).toBe(true);
      expect(CollectionNote.destroy).toHaveBeenCalledWith(expect.objectContaining({ where: { collectionId: 60, noteId: 5 } }));
      expect(note.update).toHaveBeenCalledWith({ companyId: 7 }, expect.anything());
    });

    it("allows a step while it is still in two companies, without a company yet", async () => {
      const note = setup([{ id: 1, companyId: 7 }, { id: 60, companyId: 8 }, { id: 61, companyId: 9 }]);
      expect(await CollectionService.removeNote(61, 4, 5)).toBe(true);
      expect(note.update).not.toHaveBeenCalledWith(expect.objectContaining({ companyId: expect.anything() }), expect.anything());
    });

    it("refuses to take it out of its last company collection", async () => {
      setup([{ id: 1, companyId: 7 }, { id: 9, companyId: null }]);
      const err = await failure(CollectionService.removeNote(1, 4, 5));
      expect(err.status).toBe(409);
      expect(CollectionNote.destroy).not.toHaveBeenCalled();
    });
  });

  it("is left out of the personal export, like any work item", async () => {
    vi.spyOn(Note, "findAll").mockResolvedValue([
      fakeNote({ id: 5, companyId: 7, title: "work", content: {} }),
      fakeNote({ id: 6, companyId: null, title: "mine", content: {} }),
    ] as never);
    const result = await NoteService.exportNotes(3);
    expect(result.notes.map((note: any) => note.title)).toEqual(["mine"]);
  });
});

describe("collectionsByNoteId legacy links", () => {
  it("finds trashed items linked by the old column too", async () => {
    vi.mocked(CollectionService.collectionsByNoteId).mockRestore();
    vi.spyOn(CollectionNote, "findAll").mockResolvedValue([] as never);
    const findAll = vi.spyOn(Note, "findAll").mockResolvedValue([] as never);
    await CollectionService.collectionsByNoteId([5]);
    expect(findAll).toHaveBeenCalledWith(expect.objectContaining({ paranoid: false }));
  });
});

describe("a new work item and a collection key replaced meanwhile", () => {
  const create = () =>
    NoteService.createNote(3, {
      title: "",
      content: {},
      category: "login",
      collectionIds: [1],
      e2e: { e2eId: E2E_ID, encData: ENC_DATA } as any,
    });

  it("locks the collections and refuses (rolled back) when its copies are no longer current", async () => {
    const TX = { LOCK: { UPDATE: "UPDATE", SHARE: "SHARE" } };
    let rolledBack = false;
    vi.mocked(sequelize.transaction).mockImplementation((async (fn: any) => {
      try {
        return await fn(TX);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    }) as never);
    vi.spyOn(E2EItemService, "storeNewItemKeys").mockResolvedValue(undefined as never);
    vi.mocked(E2EItemService.coversCollections).mockResolvedValue(false as never);
    const err = await failure(create());
    expect(err.status).toBe(409);
    expect(rolledBack).toBe(true);
    expect(Collection.findAll).toHaveBeenCalledWith(expect.objectContaining({ lock: "SHARE", transaction: TX }));
    expect(E2EItemService.coversCollections).toHaveBeenCalledWith(5, [1], TX);
  });
});

describe("a refused move doesn't save the edit", () => {
  it("sealed item: nothing written when the move into a company is refused", async () => {
    vi.mocked(E2EItemService.coversCollections).mockResolvedValue(false as never);
    const note = fakeNote({ e2e: true, itemKey: ITEM_KEY });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "owner" } as never);
    const err = await failure(NoteService.updateNote(5, 3, { collectionIds: [1], encData: ENC_DATA }));
    expect(err.status).toBe(409);
    expect(note.update).not.toHaveBeenCalledWith(expect.objectContaining({ encData: ENC_DATA }));
  });

  it("readable item: the edit isn't saved when linking fails", async () => {
    vi.mocked(CollectionService.setNoteCollections).mockRejectedValue(new Error("db down"));
    const note = fakeNote({ title: "old", content: {}, tags: [] });
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note, permission: "owner" } as never);
    await expect(NoteService.updateNote(5, 3, { title: "new", collectionIds: [1] })).rejects.toThrow("db down");
    expect(note.update).not.toHaveBeenCalledWith(expect.objectContaining({ title: "new" }));
  });
});
