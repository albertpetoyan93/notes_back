import { afterEach, describe, expect, it, vi } from "vitest";
import NoteService from "@src/services/NoteService";

afterEach(() => vi.restoreAllMocks());

describe("saving a passkey from the extension", () => {
  it("SEC06: never writes a readable passkey into an end-to-end item", async () => {
    const update = vi.fn();
    vi.spyOn(NoteService as any, "getNoteAccess").mockResolvedValue({ permission: "edit", note: { id: 5, e2e: true, content: null, update } });
    const passkey = { credentialId: "Y3JlZA", rpId: "example.com", userHandle: "dQ", userName: "sam", privateKey: "cHJpdg", publicKey: "cHVi", algorithm: -7, signCount: 0 };
    const err = await NoteService.savePasskey(1, { noteId: 5, passkey }).catch((error) => error);
    expect(err).toMatchObject({ status: 409 });
    expect(update).not.toHaveBeenCalled();
  });
});
