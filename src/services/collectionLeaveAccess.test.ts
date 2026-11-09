import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Note from "@src/models/Note";
import NoteShare from "@src/models/NoteShare";
import CollectionService from "@src/services/CollectionService";
import E2EItemService from "@src/services/E2EItemService";
import NoteService from "@src/services/NoteService";

const MESSAGE = "You can't remove this item from a collection you can't edit.";

function fakeNote(fields: Record<string, unknown> = {}) {
  return { id: 5, userId: 3, e2e: true, companyId: 7, ...fields } as any;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

// Collection permissions of the caller (user 4); a missing key means no access.
let access: Record<number, "owner" | "edit" | "view">;

beforeEach(() => {
  access = { 1: "edit", 2: "view" };
  vi.spyOn(CollectionService, "getAccess").mockImplementation((async (id: number) =>
    access[id] ? { collection: { id }, permission: access[id] } : null) as never);
  vi.spyOn(CollectionService, "assertCanAdd").mockResolvedValue({ collection: { id: 1 } } as never);
  vi.spyOn(CollectionService, "checkNoteCollections").mockImplementation((async (_note: any, ids: number[]) => ({
    ids,
    companyId: 7,
    movesToCompany: false,
  })) as never);
  vi.spyOn(CollectionService, "collectionsByNoteId").mockResolvedValue(
    new Map([
      [
        5,
        [
          { id: 1, name: "A", companyId: 7 },
          { id: 2, name: "B", companyId: 7 },
        ],
      ],
    ]) as never
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saving a work item with a new collection list", () => {
  const change = (ids: number[], permission: "edit" | "owner" = "edit", note = fakeNote(), userId = 4) =>
    (NoteService as any).collectionChange(note, permission, userId, { collectionIds: ids });

  it("is refused when it drops a collection the caller can only view", async () => {
    const err = await failure(change([1]));
    expect(err.status).toBe(403);
    expect(err.message).toBe(MESSAGE);
  });

  it("is refused when it drops a collection the caller has no access to", async () => {
    delete access[2];
    const err = await failure(change([1]));
    expect(err.status).toBe(403);
  });

  it("is allowed when the caller can edit the dropped collection", async () => {
    access[2] = "edit";
    expect((await change([1]))?.ids).toEqual([1]);
  });

  it("is allowed when nothing is dropped", async () => {
    expect((await change([1, 2]))?.ids).toEqual([1, 2]);
  });

  it("is allowed for a personal item between the owner's own collections", async () => {
    access = { 1: "owner", 2: "owner" };
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([[5, [{ id: 1, name: "A", companyId: null }, { id: 2, name: "B", companyId: null }]]]) as never
    );
    expect((await change([1], "owner", fakeNote({ companyId: null }), 3))?.ids).toEqual([1]);
  });
});

describe("moving work items in bulk", () => {
  beforeEach(() => {
    vi.spyOn(Note, "findAll").mockResolvedValue([fakeNote()] as never);
    vi.spyOn(NoteShare, "findAll").mockResolvedValue([] as never);
    vi.spyOn(CollectionService, "openCompanyCollections").mockResolvedValue(
      new Map([[1, "edit"], [2, "view"]]) as never
    );
    vi.spyOn(CollectionService, "activeCompanyIds").mockResolvedValue(new Set([7]) as never);
    vi.spyOn(E2EItemService, "ensure").mockResolvedValue(undefined as never);
    vi.spyOn(CollectionService, "commitNoteCollections").mockResolvedValue(undefined as never);
  });

  it("is refused when the move drops a collection the caller can't edit", async () => {
    const err = await failure(NoteService.bulkUpdate(4, [5], "move", 1));
    expect(err.status).toBe(403);
    expect(err.message).toBe(MESSAGE);
    expect(CollectionService.commitNoteCollections).not.toHaveBeenCalled();
  });

  it("goes through when the caller can edit every dropped collection", async () => {
    access[2] = "edit";
    vi.mocked(CollectionService.openCompanyCollections).mockResolvedValue(
      new Map([[1, "edit"], [2, "edit"]]) as never
    );
    const result = await NoteService.bulkUpdate(4, [5], "move", 1);
    expect(result.updated).toBe(1);
    expect(CollectionService.commitNoteCollections).toHaveBeenCalledTimes(1);
  });
});
