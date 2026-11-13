import { afterEach, describe, expect, it, vi } from "vitest";
import notesRouter from "@src/routes/notes";
import CollectionService from "@src/services/CollectionService";
import NoteService from "@src/services/NoteService";

afterEach(() => vi.restoreAllMocks());

const E2E_REQUIRED = { status: 409, code: "e2e_required", message: "Unlock your vault and try again." };

describe("stage 10.6: the server only takes sealed items", () => {
  it("creating an item without its sealed data is refused", async () => {
    vi.spyOn(CollectionService, "collectionRefs").mockResolvedValue([] as never);
    const err = await NoteService.createNote(1, { title: "Bank", content: { mainContent: "pw" } } as never).catch((e) => e);
    expect(err).toMatchObject(E2E_REQUIRED);
  });

  it("changing a readable item is refused", async () => {
    vi.spyOn(NoteService, "getNoteAccess").mockResolvedValue({ permission: "owner", note: { id: 5, e2e: false } } as never);
    const err = await NoteService.updateNote(5, 1, { title: "Bank 2" } as never).catch((e) => e);
    expect(err).toMatchObject(E2E_REQUIRED);
  });

  it("the readable import, version restore and passkey save routes are gone", () => {
    const routes = (notesRouter as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
    expect(routes).not.toContain("post /import");
    expect(routes).not.toContain("post /:id/versions/:versionId/restore");
    expect(routes).not.toContain("post /passkeys");
  });
});
