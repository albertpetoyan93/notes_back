import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Note from "@src/models/Note";
import NoteShare from "@src/models/NoteShare";
import Collection from "@src/models/Collection";
import CollectionShare from "@src/models/CollectionShare";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import ItemKey from "@src/models/ItemKey";
import CollectionNote from "@src/models/CollectionNote";
import NoteFavorite from "@src/models/NoteFavorite";
import NoteVersion from "@src/models/NoteVersion";
import AccessService from "@src/services/AccessService";
import sequelize from "@src/configs/DB/sequelize";
import CollectionService from "@src/services/CollectionService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import GroupService from "@src/services/GroupService";
import E2EItemService from "@src/services/E2EItemService";
import NoteService, { canManage } from "@src/services/NoteService";

const ITEM_KEY = `e2e1.${"b".repeat(16)}.${"c".repeat(43)}`;
const SEALED = `e2e1x.${"a".repeat(43)}.${"b".repeat(16)}.${"c".repeat(43)}`;

// User 3 made work item 5 in collection 1 of company 7.
let membership: { companyId: number; userId: number; role: string; status: string };
let companyShare: string;

function fakeNote(fields: Record<string, unknown> = {}) {
  const note = { id: 5, userId: 3, e2e: true, companyId: 7, itemKey: ITEM_KEY, updatedAt: new Date(), ...fields } as any;
  note.toJSON = () => ({ ...note });
  note.destroy = vi.fn();
  return note;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

beforeEach(() => {
  membership = { companyId: 7, userId: 3, role: "member", status: "active" };
  companyShare = "view";
  // Membership lookups honour the status they ask for, as the database would.
  vi.spyOn(CompanyMember, "findAll").mockImplementation((async (options: any) =>
    [membership].filter(
      (row) =>
        (options.where.status === undefined || options.where.status === row.status) &&
        (options.where.userId === undefined || options.where.userId === row.userId)
    )) as never);
  vi.spyOn(Company, "findAll").mockResolvedValue([{ id: 7 }] as never);
  vi.spyOn(CompanyPolicyService, "forUser").mockResolvedValue({ blocked: new Set() } as never);
  vi.spyOn(Collection, "findAll").mockImplementation((async () => [{ id: 1, companyShare }]) as never);
  vi.spyOn(CollectionShare, "findAll").mockResolvedValue([] as never);
  vi.spyOn(GroupService, "forUser").mockResolvedValue(new Map() as never);
  vi.spyOn(CollectionService, "collectionsByNoteId").mockResolvedValue(
    new Map([[5, [{ id: 1, name: "Team", companyId: 7 }]]]) as never
  );
  vi.spyOn(NoteShare, "findOne").mockResolvedValue(null as never);
  vi.spyOn(Note, "findByPk").mockResolvedValue(fakeNote() as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a suspended member", () => {
  it("opens no company collection and counts in no company", async () => {
    membership.status = "suspended";
    expect((await CollectionService.openCompanyCollections(3)).size).toBe(0);
    expect((await CollectionService.activeCompanyIds(3)).size).toBe(0);
  });

  it("gets nothing for a work item they created", async () => {
    membership.status = "suspended";
    expect(await NoteService.getNoteAccess(5, 3)).toBeNull();
  });

  it("gets nothing through a direct share either", async () => {
    membership.status = "suspended";
    vi.mocked(NoteShare.findOne).mockResolvedValue({ permission: "edit" } as never);
    expect(await NoteService.getNoteAccess(5, 3)).toBeNull();
  });
});

describe("the creator of a work item", () => {
  it("gets what their company access gives: view, not owner", async () => {
    const access = await NoteService.getNoteAccess(5, 3);
    expect(access?.permission).toBe("view");
  });

  it("gets edit when the company gives edit", async () => {
    companyShare = "edit";
    const access = await NoteService.getNoteAccess(5, 3);
    expect(access?.permission).toBe("edit");
  });

  it("is not shown as owner and gets no key copy, even a stale one", async () => {
    vi.spyOn(NoteService as any, "getAccessMaps").mockResolvedValue({ permissionByNoteId: new Map() });
    vi.spyOn(NoteService as any, "getFavoriteNoteIds").mockResolvedValue(new Set());
    vi.spyOn(NoteService as any, "directlySharedIds").mockResolvedValue(new Set());
    vi.spyOn(E2EItemService, "keyPathsFor").mockResolvedValue(new Map() as never);
    const note: any = await NoteService.getNoteById(5, 3);
    expect(note.isOwner).toBe(false);
    expect(note.permission).toBe("view");
    expect(note.itemKey).toBeNull();
  });

  it("can't share it with view-only access", async () => {
    const err = await failure(NoteService.getNoteShares(5, 3));
    expect(err.status).toBe(404);
  });

  it("can't delete it with view-only access", async () => {
    const note = fakeNote();
    vi.mocked(Note.findByPk).mockResolvedValue(note as never);
    expect(await NoteService.deleteNote(5, 3)).toBe(false);
    expect(note.destroy).not.toHaveBeenCalled();
  });
});

describe("a personal item", () => {
  beforeEach(() => {
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(new Map() as never);
    vi.mocked(Note.findByPk).mockResolvedValue(fakeNote({ companyId: null }) as never);
  });

  it("still belongs to its creator, with their key copy", async () => {
    expect((await NoteService.getNoteAccess(5, 3))?.permission).toBe("owner");
    vi.spyOn(NoteService as any, "getAccessMaps").mockResolvedValue({ permissionByNoteId: new Map() });
    vi.spyOn(NoteService as any, "getFavoriteNoteIds").mockResolvedValue(new Set());
    vi.spyOn(E2EItemService, "keyPathsFor").mockResolvedValue(new Map() as never);
    const note: any = await NoteService.getNoteById(5, 3);
    expect(note.isOwner).toBe(true);
    expect(note.itemKey).toBe(ITEM_KEY);
  });
});

describe("canManage", () => {
  it("is edit on a work item, never the creator", () => {
    expect(canManage({ note: { companyId: 7, userId: 3 }, permission: "edit" }, 4)).toBe(true);
    expect(canManage({ note: { companyId: 7, userId: 3 }, permission: "view" }, 3)).toBe(false);
    expect(canManage({ note: { companyId: 7, userId: 3 }, permission: "owner" }, 3)).toBe(false);
    expect(canManage({ note: { companyId: null, userId: 3 }, permission: "owner" }, 3)).toBe(true);
  });
});

describe("giving a work item's key to a person (applyKeys share entry)", () => {
  beforeEach(() => {
    vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({ LOCK: { UPDATE: "UPDATE" } })) as never);
    vi.spyOn(Note, "findOne").mockResolvedValue({ id: 5, userId: 3, companyId: 7 } as never);
    vi.spyOn(ItemKey, "destroy").mockResolvedValue(0 as never);
    vi.spyOn(ItemKey, "create").mockResolvedValue({} as never);
  });

  const entry = { shares: [{ noteId: 5, userId: 8, wrappedKey: SEALED }] };

  it("is accepted from an editor who didn't create it", async () => {
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note: fakeNote(), permission: "edit" } as never);
    await E2EItemService.applyKeys(4, entry);
    expect(ItemKey.create).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: 5, containerType: "user", containerId: 8 }),
      expect.anything()
    );
  });

  it("is refused from a viewer, even its creator, with 403", async () => {
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ note: fakeNote(), permission: "view" } as never);
    const err = await failure(E2EItemService.applyKeys(3, entry));
    expect(err.status).toBe(403);
    expect(ItemKey.create).not.toHaveBeenCalled();
  });

  it("still takes a personal item's share only from its owner", async () => {
    vi.mocked(Note.findOne).mockResolvedValue({ id: 5, userId: 3, companyId: null } as never);
    const err = await failure(E2EItemService.applyKeys(4, entry));
    expect(err.status).toBe(403);
    await E2EItemService.applyKeys(3, entry);
    expect(ItemKey.create).toHaveBeenCalledTimes(1);
  });
});

describe("changing many items at once", () => {
  beforeEach(() => {
    vi.spyOn(Note, "findAll").mockResolvedValue([fakeNote(), fakeNote({ id: 6, userId: 4 })] as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([
        [5, [{ id: 1, name: "Team", companyId: 7 }]],
        [6, [{ id: 2, name: "Ops", companyId: 7 }]],
      ]) as never
    );
    vi.spyOn(NoteShare, "findAll").mockResolvedValue([] as never);
  });

  it("takes work items the caller can manage, whoever made them, and skips the rest", async () => {
    vi.spyOn(CollectionService, "openCompanyCollections").mockResolvedValue(
      new Map([[1, "view"], [2, "edit"]]) as never
    );
    const result = await NoteService.bulkUpdate(3, [5, 6], "trash");
    expect(result.noteIds).toEqual([6]);
    expect(result.skipped).toBe(1);
  });
});

describe("items you can add to a collection", () => {
  it("are your personal items only, never a work item (even for its suspended creator)", async () => {
    membership.status = "suspended";
    vi.spyOn(CollectionService, "assertCanAdd").mockResolvedValue({ collection: { id: 1 } } as never);
    vi.spyOn(CollectionService, "noteIdsForCollections").mockResolvedValue([] as never);
    const findAll = vi
      .spyOn(Note, "findAll")
      .mockResolvedValue([fakeNote({ companyId: null }), fakeNote({ id: 6, companyId: null })] as never);
    // Item 5 still sits in company 7's collection (left without a companyId).
    const notes = (await CollectionService.availableNotes(1, 3)) as any[];
    expect(notes.map((note) => note.id)).toEqual([6]);
    expect((findAll.mock.calls[0][0] as any).where).toHaveProperty("companyId");
  });
});

describe("a favorite on a work item", () => {
  it("comes back without the creator key copy", async () => {
    vi.spyOn(NoteFavorite, "findOne").mockResolvedValue(null as never);
    vi.spyOn(NoteService as any, "setUserFavorite").mockResolvedValue(undefined);
    vi.spyOn(NoteService as any, "getSharedNoteIds").mockResolvedValue({ permissionByNoteId: new Map() });
    vi.spyOn(NoteService as any, "getFavoriteNoteIds").mockResolvedValue(new Set([5]));
    vi.spyOn(E2EItemService, "keyPathsFor").mockResolvedValue(new Map() as never);
    const note: any = await NoteService.toggleFavorite(5, 3);
    expect(note.isOwner).toBe(false);
    expect(note.itemKey).toBeNull();
    expect(note.e2eKeys).toEqual({ collections: [] });
  });
});

describe("a legacy item still in company collections (no companyId)", () => {
  const legacy = () => fakeNote({ companyId: null });
  beforeEach(() => {
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 2, name: "Ops", companyId: 7 }, { id: 4, name: "Other", companyId: 8 }]]]) as never
    );
  });

  it("can't be added elsewhere by its creator without edit access", async () => {
    vi.spyOn(CollectionService, "assertCanAdd").mockResolvedValue({ collection: { id: 1 } } as never);
    vi.spyOn(Note, "findAll").mockResolvedValue([legacy()] as never);
    vi.spyOn(CollectionService, "addNoteToCollection").mockResolvedValue(undefined as never);
    const err = await failure(CollectionService.addNotes(1, 3, [5]));
    expect(err.status).toBe(400);
    expect(CollectionService.addNoteToCollection).not.toHaveBeenCalled();
  });

  it("can't be taken out of a collection by its view-only creator", async () => {
    vi.spyOn(CollectionService, "getAccess").mockResolvedValue({ collection: { id: 2 }, permission: "view" } as never);
    vi.mocked(Note.findByPk).mockResolvedValue(legacy() as never);
    vi.spyOn(CollectionNote, "findOne").mockResolvedValue({} as never);
    vi.spyOn(CollectionNote, "destroy").mockResolvedValue(1 as never);
    expect(await CollectionService.removeNote(2, 3, 5)).toBe(false);
    expect(CollectionNote.destroy).not.toHaveBeenCalled();
  });
});

describe("a work item in the trash", () => {
  let trashed: any;
  beforeEach(() => {
    trashed = fakeNote({ deletedAt: new Date() });
    trashed.restore = vi.fn();
    vi.spyOn(NoteShare, "findAll").mockResolvedValue([] as never);
    vi.spyOn(CollectionService, "noteIdsForCollections").mockResolvedValue([5] as never);
    vi.spyOn(Note, "findOne").mockResolvedValue(trashed as never);
  });

  async function listTrash(userId: number) {
    vi.spyOn(NoteService, "purgeOldTrash").mockResolvedValue(undefined);
    vi.spyOn(NoteService as any, "getAccessMaps").mockResolvedValue({
      sharedNoteIds: [],
      permissionByNoteId: new Map(),
      ownedCollectionIds: [],
    });
    vi.spyOn(NoteService as any, "getFavoriteNoteIds").mockResolvedValue(new Set());
    vi.spyOn(NoteService as any, "managedCompanyIds").mockResolvedValue(new Set());
    vi.spyOn(NoteService as any, "directlySharedIds").mockResolvedValue(new Set());
    vi.spyOn(AccessService, "countsByNote").mockResolvedValue(new Map() as never);
    vi.spyOn(E2EItemService, "keyPathsFor").mockResolvedValue(new Map() as never);
    vi.spyOn(CollectionService, "listForCompany").mockResolvedValue([{ id: 1 }] as never);
    const findAll = vi.spyOn(Note, "findAll").mockResolvedValue([trashed] as never);
    await NoteService.getNotes(userId, { companyId: 7, trash: true } as any);
    // The list query is the one that loads the items with their includes.
    const listed = findAll.mock.calls.map((call) => call[0] as any).find((options) => options.include);
    return listed.where;
  }

  const ids = (where: any) => Object.getOwnPropertySymbols(where.id).map((key) => where.id[key])[0];

  it("is listed and restorable for an editor who didn't make it", async () => {
    companyShare = "edit";
    membership.userId = 4;
    const where = await listTrash(4);
    expect(ids(where)).toEqual([5]);
    expect(where.deletedAt).toBeDefined();
    expect(await NoteService.restoreNote(5, 4)).toBe(true);
    expect(trashed.restore).toHaveBeenCalled();
  });

  it("is restorable through a direct edit share", async () => {
    companyShare = "none";
    membership.userId = 4;
    vi.mocked(NoteShare.findAll).mockResolvedValue([{ noteId: 5, permission: "edit" }] as never);
    expect(await NoteService.restoreNote(5, 4)).toBe(true);
  });

  it("is hidden from and not restorable by its suspended creator", async () => {
    companyShare = "edit";
    membership.status = "suspended";
    const where = await listTrash(3);
    expect(ids(where)).toEqual([-1]);
    expect(await NoteService.restoreNote(5, 3)).toBe(false);
    expect(trashed.restore).not.toHaveBeenCalled();
  });
});
