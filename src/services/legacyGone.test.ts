import { afterEach, describe, expect, it, vi } from "vitest";
import sequelize from "@src/configs/DB/sequelize";
import Note from "@src/models/Note";
import User from "@src/models/User";
import authRouter from "@src/routes/auth";
import notesRouter from "@src/routes/notes";
import E2EAccountService from "@src/services/E2EAccountService";
import E2EItemService from "@src/services/E2EItemService";
import { table } from "@src/services/recoveryTestDb";
import { reencryptAll } from "@src/util/reencrypt";

afterEach(() => vi.restoreAllMocks());

const routesOf = (router: any) =>
  router.stack.filter((layer: any) => layer.route).map((layer: any) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);

describe("stage 10.6: the migration-era code is gone", () => {
  it("the routes for readable items and accounts without keys are gone", () => {
    const notes = routesOf(notesRouter);
    for (const route of ["get /e2e/pending", "post /e2e/migrate", "post /e2e/unseal"]) expect(notes).not.toContain(route);
    const auth = routesOf(authRouter);
    for (const route of ["post /e2e/enable", "post /e2e/check-password", "post /reset-password"]) expect(auth).not.toContain(route);
  });

  it("prelogin answers like an end-to-end account for any known address", async () => {
    table(User, [{ id: 1, email: "old@example.com", e2eEnabled: false, kdfSalt: null, kdfParams: null }]);
    const answer = await E2EAccountService.prelogin("old@example.com");
    expect(answer).toMatchObject({ e2e: true, kdf: expect.objectContaining({ salt: expect.any(String) }) });
  });

  it("an item someone can't open yet is a plain 409, not a request to make it readable", async () => {
    vi.spyOn(Note, "findAll").mockResolvedValue([{ id: 5, userId: 1, companyId: null, e2eId: "x" }] as never);
    vi.spyOn(E2EItemService as any, "plan").mockResolvedValue({ needs: { collections: [], items: [], shares: [] }, blocked: new Set([5]) });
    const err = await E2EItemService.ensure(1, [5], undefined).catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
    expect(err.code).toBeUndefined();
  });

  it("npm run reencrypt rewrites 2FA secrets and secret-link labels, and never touches items", async () => {
    const sql: string[] = [];
    vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({})) as never);
    vi.spyOn(sequelize, "query").mockImplementation((async (text: string) => {
      sql.push(String(text));
      return /to_regclass/.test(String(text)) ? [{ exists: true }] : [];
    }) as never);
    await reencryptAll();
    expect(sql.some((text) => /FROM "secret_links"/.test(text))).toBe(true);
    expect(sql.some((text) => /twoFactorSecret/.test(text))).toBe(true);
    expect(sql.some((text) => /"notes"|note_versions/.test(text))).toBe(false);
  });
});

describe("stage 10.6 halfway review", () => {
  it("npm run reencrypt (and migration 023) works on a fresh database without the secret_links table", async () => {
    const sql: string[] = [];
    vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({})) as never);
    vi.spyOn(sequelize, "query").mockImplementation((async (text: string) => {
      sql.push(String(text));
      return /to_regclass/.test(String(text)) ? [{ exists: false }] : [];
    }) as never);
    await reencryptAll();
    expect(sql.some((text) => /FROM "secret_links"/.test(text))).toBe(false);
  });

  it("a sealed item never carries the server's old placeholder in `content`", async () => {
    const NoteService = (await import("@src/services/NoteService")).default;
    const json = (NoteService as any).annotateNote(
      { id: 5, userId: 1, e2e: true, companyId: null, toJSON: () => ({ id: 5, userId: 1, e2e: true, content: "v2:1:aa:bb:cc" }) },
      1,
      new Map(),
      new Set(),
      []
    );
    expect(json.content).toEqual({});
  });

  it("adding an item to a collection doesn't copy the collection's name onto it", async () => {
    const CollectionService = (await import("@src/services/CollectionService")).default;
    const CollectionNote = (await import("@src/models/CollectionNote")).default;
    vi.spyOn(CollectionNote, "findOrCreate").mockResolvedValue([{}, true] as never);
    const update = vi.fn();
    vi.spyOn(Note, "findByPk").mockResolvedValue({ collectionId: null, update } as never);
    await CollectionService.addNoteToCollection(5, 9, "Bank logins");
    expect(update).toHaveBeenCalledWith({ collectionId: 9 }, expect.anything());
  });
});

describe("stage 10.6: unlocking", () => {
  it("a typed password no longer unlocks a session: only the master password's derived key does", async () => {
    const LockController = (await import("@src/controller/LockController")).default;
    const AuditService = (await import("@src/services/AuditService")).default;
    const SessionService = (await import("@src/services/SessionService")).default;
    vi.spyOn(AuditService, "record").mockResolvedValue(undefined as never);
    const unlock = vi.spyOn(SessionService, "unlock").mockResolvedValue(undefined as never);
    vi.spyOn(User, "findByPk").mockResolvedValue({ id: 1, e2eEnabled: false, comparePassword: async (value: string) => value === "hunter22" } as never);
    const res: any = { status: vi.fn(() => res), send: vi.fn(() => res), json: vi.fn(() => res) };
    await LockController.unlock({ user: { id: 1, sessionId: 9 }, body: { password: "hunter22" } } as never, res, vi.fn());
    expect(unlock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("stage 10.6 final review", () => {
  it("before migration 057 runs, a leftover readable row doesn't send its server placeholder either", async () => {
    const NoteService = (await import("@src/services/NoteService")).default;
    const json = (NoteService as any).annotateNote(
      { id: 6, userId: 1, e2e: false, companyId: null, toJSON: () => ({ id: 6, userId: 1, e2e: false, content: "v2:1:aa:bb:cc" }) },
      1,
      new Map(),
      new Set(),
      []
    );
    expect(json.content).toEqual({});
  });
});
