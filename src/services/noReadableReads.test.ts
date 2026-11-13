import { afterEach, describe, expect, it, vi } from "vitest";
import AuditEvent from "@src/models/AuditEvent";
import Note from "@src/models/Note";
import AuditService from "@src/services/AuditService";
import CollectionService from "@src/services/CollectionService";
import NoteService from "@src/services/NoteService";

afterEach(() => vi.restoreAllMocks());

describe("stage 10.6: the server doesn't read item contents", () => {
  it("the old autofill and passkey lookups answer nothing (old extensions keep working)", async () => {
    const findAll = vi.spyOn(Note, "findAll");
    expect(await NoteService.autofill(1, "example.com")).toEqual([]);
    expect(await NoteService.passkeysForSite(1, "example.com")).toEqual([]);
    expect(findAll).not.toHaveBeenCalled();
  });

  it("the activity log keeps no item title", async () => {
    vi.spyOn(Note, "findByPk").mockResolvedValue({ title: "Bank", companyId: null } as never);
    vi.spyOn(AuditService as any, "companyForNote").mockResolvedValue(null);
    const create = vi.spyOn(AuditEvent, "create").mockResolvedValue({} as never);
    await AuditService.record({ actorId: 1, action: "item_viewed", noteId: 5 } as never);
    expect((create.mock.calls[0][0] as any).details?.title).toBeUndefined();
  });

  it("the personal export holds only sealed items", async () => {
    vi.spyOn(Note, "findAll").mockResolvedValue([
      { id: 1, e2e: false, title: "Old", content: { mainContent: "pw" }, companyId: null },
      { id: 2, e2e: true, e2eId: "sealed", encData: "x", companyId: null },
    ] as never);
    vi.spyOn(CollectionService, "collectionsByNoteId").mockResolvedValue(new Map() as never);
    vi.spyOn(NoteService as any, "getFavoriteNoteIds").mockResolvedValue(new Set());
    const result = await NoteService.exportNotes(1);
    expect(result.notes).toEqual([expect.objectContaining({ e2e: true, e2eId: "sealed" })]);
    expect(JSON.stringify(result)).not.toContain("pw");
  });
});
