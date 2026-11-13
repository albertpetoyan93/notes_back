import { afterEach, describe, expect, it, vi } from "vitest";
import sequelize from "@src/configs/DB/sequelize";
import Note from "@src/models/Note";
import { up } from "@src/configs/DB/migrations/057_e2e_only_items";

afterEach(() => vi.restoreAllMocks());

describe("stage 10.6: the server no longer encrypts or decrypts items", () => {
  it("a saved item keeps the content it was given (no server ciphertext)", async () => {
    const note = Note.build({ userId: 1, title: "", content: {}, category: "note", e2e: true, encData: "sealed" } as never);
    await (Note as any).runHooks("beforeCreate", note);
    expect(note.getDataValue("content")).toEqual({});
  });

  it("a loaded item's stored content is left as it is", async () => {
    const note = Note.build({ userId: 1, title: "", content: {}, category: "note", e2e: true } as never);
    // What the old hooks wrote for every item (the server-encrypted form of its content).
    const stored = "v2:1:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff:abcd";
    note.setDataValue("content", stored as never);
    note.setDataValue("isEncrypted", true as never);
    await (Note as any).runHooks("afterFind", note);
    expect(note.getDataValue("content")).toBe(stored);
  });
});

describe("migration 057", () => {
  it("refuses to run while any readable item or version exists, trashed ones too", async () => {
    const query = vi.spyOn(sequelize, "query").mockImplementation((async (sql: string) =>
      /FROM "notes"/.test(sql) ? [{ count: "2" }] : /FROM "note_versions"/.test(sql) ? [{ count: "1" }] : []) as never);
    await expect(up()).rejects.toThrow(/2 items and 1 version/);
    expect(query.mock.calls.some(([sql]) => /UPDATE/.test(String(sql)))).toBe(false);
  });

  it("blanks the leftover fields of end-to-end items when nothing readable is left", async () => {
    const query = vi.spyOn(sequelize, "query").mockImplementation((async (sql: string) =>
      /SELECT/.test(sql) ? [{ count: "0" }] : []) as never);
    await up();
    const update = query.mock.calls.map(([sql]) => String(sql)).find((sql) => /UPDATE "notes"/.test(sql));
    expect(update).toMatch(/"content" = '\{\}'::jsonb/);
    expect(update).toMatch(/WHERE "e2e" = true/);
  });
});
