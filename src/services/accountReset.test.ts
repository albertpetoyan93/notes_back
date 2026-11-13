import bcrypt from "bcrypt";
import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sequelize from "@src/configs/DB/sequelize";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import CollectionNote from "@src/models/CollectionNote";
import CollectionShare from "@src/models/CollectionShare";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import { CompanyRecoveryKey, RecoveryCustodian } from "@src/models/CompanyRecovery";
import EmergencyContact from "@src/models/EmergencyContact";
import ItemKey from "@src/models/ItemKey";
import Note from "@src/models/Note";
import NoteShare from "@src/models/NoteShare";
import User from "@src/models/User";
import UserPasskey from "@src/models/UserPasskey";
import AccountResetService from "@src/services/AccountResetService";
import AuditService from "@src/services/AuditService";
import E2EAccountService from "@src/services/E2EAccountService";
import EmailService from "@src/services/EmailService";
import NotificationService from "@src/services/NotificationService";
import SessionService from "@src/services/SessionService";
import TwoFactorService from "@src/services/TwoFactorService";
import { table } from "@src/services/recoveryTestDb";

const TOKEN = "reset-token";
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const bundle = { kdf: {}, authKey: "k", protectedUserKey: "p", publicKey: "P", protectedPrivateKey: "pp", recoveryProtectedUserKey: "r", recoveryAuth: "ra" };

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

let db: Record<string, any[]>;

// Sam (3) lost their master password and recovery key. They're a member of company 7, a recovery custodian there,
// and the only one holding vault 40's key. Personal items 1 (shared with 9) and 2; company item 3; item 4 is someone
// else's, shared with Sam.
beforeEach(() => {
  vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({ id: "tx" })) as never);
  vi.spyOn(SessionService, "revokeAll").mockResolvedValue(undefined as never);
  vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
  vi.spyOn(EmailService, "sendSecurityNotice").mockResolvedValue(true as never);
  vi.spyOn(AuditService, "record").mockResolvedValue(undefined as never);
  vi.spyOn(TwoFactorService, "verify").mockImplementation(async (_id: number, code: string) => code === "123456");
  vi.spyOn(E2EAccountService, "checkedBundle").mockImplementation(async () => ({ publicKey: "NEW", password: "hashed" }) as never);
  db = {
    users: table(User, [
      { id: 3, email: "sam@acme.com", e2eEnabled: true, twoFactorEnabled: false, passwordResetTokenHash: hash(TOKEN), passwordResetExpires: new Date(Date.now() + 3600_000) },
      { id: 1, email: "olga@acme.com", e2eEnabled: true },
      { id: 9, email: "pat@example.com", e2eEnabled: true },
    ]),
    companies: table(Company, [{ id: 7, name: "Acme", status: "active" }]),
    members: table(CompanyMember, [
      { id: 11, companyId: 7, userId: 1, role: "owner", status: "active" },
      { id: 13, companyId: 7, userId: 3, role: "member", status: "active" },
    ]),
    notes: table(Note, [
      { id: 1, userId: 3, companyId: null, e2e: true },
      { id: 2, userId: 3, companyId: null, e2e: true },
      { id: 3, userId: 3, companyId: 7, e2e: true },
      { id: 4, userId: 9, companyId: null, e2e: true },
    ]),
    noteShares: table(NoteShare, [
      { id: 1, noteId: 1, sharedWithUserId: 9, expiresAt: null },
      { id: 2, noteId: 4, sharedWithUserId: 3, expiresAt: null },
    ]),
    collections: table(Collection, [
      { id: 40, companyId: 7, userId: 1, e2eKeyVersion: 2 },
      { id: 50, companyId: null, userId: 3, family: false, nameKey: "user" },
    ]),
    collectionShares: table(CollectionShare, []),
    collectionNotes: table(CollectionNote, []),
    collectionKeys: table(CollectionKey, [{ id: 1, collectionId: 40, userId: 3, keyVersion: 2, wrappedKey: "x" }]),
    itemKeys: table(ItemKey, [{ id: 1, noteId: 4, containerType: "user", containerId: 3, wrappedKey: "y" }]),
    recoveryKeys: table(CompanyRecoveryKey, [{ id: 1, companyId: 7, userId: 3, keyVersion: 1, wrappedKey: "z" }]),
    custodians: table(RecoveryCustodian, [{ id: 1, companyId: 7, userId: 3 }]),
    passkeys: table(UserPasskey, [{ id: 1, userId: 3, prfUserKey: "unlock" }]),
    emergency: table(EmergencyContact, [
      { id: 1, grantorId: 3, contactId: 9, status: "confirmed", sealedUserKey: "old-sam-key" },
      { id: 2, grantorId: 9, contactId: 3, status: "confirmed", sealedUserKey: "pat-key-for-sam" },
    ]),
  };
});

describe("account reset review fixes", () => {
  it("I1: a link used meanwhile by another request resets nothing", async () => {
    vi.mocked(E2EAccountService.checkedBundle).mockImplementationOnce(async () => {
      db.users[0].passwordResetTokenHash = null; // the other request committed first
      return { publicKey: "NEW" } as never;
    });
    expect((await failure(AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" }))).status).toBe(404);
    expect(db.notes).toHaveLength(4);
  });

  it("I2: items not yet end-to-end encrypted are kept (they can still be read)", async () => {
    db.notes.push({ id: 5, userId: 3, companyId: null, e2e: false });
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect(db.notes.map((note) => note.id).sort()).toEqual([3, 4, 5]);
  });

  it("I3: items in a company vault or the family collection are kept (others open them with that vault's key)", async () => {
    db.notes.push(
      { id: 6, userId: 3, companyId: null, e2e: true },
      { id: 7, userId: 3, companyId: null, e2e: true },
      { id: 8, userId: 3, companyId: null, e2e: true, collectionId: 60 } // legacy link
    );
    db.collections.push({ id: 60, companyId: null, userId: 9, family: true });
    db.collectionNotes.push({ id: 1, collectionId: 40, noteId: 6 }, { id: 2, collectionId: 60, noteId: 7 });
    const check: any = await AccountResetService.check(TOKEN);
    expect(check.personalItems).toBe(2); // 1, 2
    expect(check.sharedWithOthers).toBe(1);
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect(db.notes.map((note) => note.id).sort()).toEqual([3, 4, 6, 7, 8]);
  });

  it("I6: says when Sam runs the family collection (nobody else can give Sam its key back)", async () => {
    expect((await AccountResetService.check(TOKEN) as any).familyCollectionLocked).toBe(false);
    db.collections.push({ id: 61, companyId: null, userId: 3, family: true, e2eKeyVersion: 1 });
    expect((await AccountResetService.check(TOKEN) as any).familyCollectionLocked).toBe(true);
  });

  it("I4: a vault whose only other holder can't hand it on (a plain member) is still reported", async () => {
    db.users.push({ id: 8, email: "mo@acme.com", e2eEnabled: true });
    db.members.push({ id: 18, companyId: 7, userId: 8, role: "member", status: "active" });
    db.collectionKeys.push({ id: 2, collectionId: 40, userId: 8, keyVersion: 2, wrappedKey: "m" });
    expect((await AccountResetService.check(TOKEN) as any).orphanedVaults).toEqual([{ companyName: "Acme", vaultId: 40 }]);
  });

  it("ADR-002 I3: an admin holder without a manager grant can't hand the vault back; a managing member can", async () => {
    db.collectionKeys.push({ id: 3, collectionId: 40, userId: 1, keyVersion: 2, wrappedKey: "o" });
    // Olga (owner) holds the key but doesn't manage vault 40: still orphaned.
    expect((await AccountResetService.check(TOKEN) as any).orphanedVaults).toEqual([{ companyName: "Acme", vaultId: 40 }]);
    db.users.push({ id: 8, email: "mo@acme.com", e2eEnabled: true });
    db.members.push({ id: 18, companyId: 7, userId: 8, role: "member", status: "active" });
    db.collectionKeys.push({ id: 4, collectionId: 40, userId: 8, keyVersion: 2, wrappedKey: "m" });
    db.collectionShares.push({ id: 7, collectionId: 40, sharedByUserId: 1, sharedWithUserId: 8, permission: "edit", manages: true, expiresAt: null });
    expect((await AccountResetService.check(TOKEN) as any).orphanedVaults).toEqual([]);
  });

  it("I5: reports a company recovery key only Sam holds, and tells the owners", async () => {
    db.companies[0].recoveryKeyVersion = 1;
    expect((await AccountResetService.check(TOKEN) as any).recoveryKeyLost).toEqual(["Acme"]);
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    const toOwner = vi.mocked(NotificationService.create).mock.calls.find(([id]) => id === 1)?.[1];
    expect(toOwner).toMatch(/vault recovery key: set up vault recovery again/i);
  });

  it("I10: owners hear that direct shares come back when the sharer next opens the item", async () => {
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    const toSam = vi.mocked(NotificationService.create).mock.calls.find(([id]) => id === 3)?.[1];
    expect(toSam).toMatch(/shared with you .*come back/i);
  });

  it("I7: emergency access is set back to be confirmed again, both ways", async () => {
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect(db.emergency).toEqual([
      expect.objectContaining({ id: 1, status: "accepted", sealedUserKey: null }),
      expect.objectContaining({ id: 2, status: "accepted", sealedUserKey: null }),
    ]);
  });

  it("I8: sessions are revoked inside the transaction", async () => {
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect(SessionService.revokeAll).toHaveBeenCalledWith(3, undefined, { id: "tx" });
  });

  it("I9: a wrong 2FA code uses up the link; the key bundle is checked first", async () => {
    db.users[0].twoFactorEnabled = true;
    vi.mocked(E2EAccountService.checkedBundle).mockRejectedValueOnce(Object.assign(new Error("Bad vault key."), { status: 400 }));
    expect((await failure(AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET", twoFactorCode: "000000" }))).status).toBe(400);
    expect(TwoFactorService.verify).not.toHaveBeenCalled();
    expect((await failure(AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET", twoFactorCode: "000000" }))).status).toBe(401);
    expect(db.users[0].passwordResetTokenHash).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("forgot password on an end-to-end account", () => {
  it("emails a single-use account-reset link (and says to use the recovery key first)", async () => {
    vi.spyOn(EmailService, "isConfigured").mockReturnValue(true);
    const send = vi.spyOn(EmailService, "sendAccountResetLink").mockResolvedValue(true as never);
    const AuthService = (await import("@src/services/AuthService")).default;
    await AuthService.requestPasswordReset("sam@acme.com");
    const token = (send.mock.calls[0][0] as any).token;
    expect(db.users[0].passwordResetTokenHash).toBe(hash(token));
    const deliver = vi.spyOn(EmailService as any, "deliver").mockResolvedValue(true);
    send.mockRestore();
    await EmailService.sendAccountResetLink({ to: "sam@acme.com", token: "t" });
    const [, , text] = deliver.mock.calls[0] as string[];
    expect(text).toMatch(/recovery key/i);
    expect(text).toContain("/auth/reset-account?token=t");
    expect(text).toMatch(/personal items .*deleted/i);
  });

  it("in production without mail, no reset link (account or password) is written to the log", async () => {
    const EnvVars = (await import("@src/common/EnvVars")).default as { NodeEnv: string };
    const logger = (await import("jet-logger")).default;
    const before = EnvVars.NodeEnv;
    EnvVars.NodeEnv = "production";
    vi.spyOn(EmailService, "isConfigured").mockReturnValue(false);
    const lines: string[] = [];
    for (const level of ["info", "warn", "err", "imp"] as const) {
      vi.spyOn(logger, level).mockImplementation(((line: unknown) => void lines.push(String(line))) as never);
    }
    db.users.push({ id: 4, email: "old@acme.com", e2eEnabled: false });
    try {
      const AuthService = (await import("@src/services/AuthService")).default;
      await AuthService.requestPasswordReset("sam@acme.com");
      await AuthService.requestPasswordReset("old@acme.com");
    } finally {
      EnvVars.NodeEnv = before;
    }
    expect(db.users.find((row) => row.id === 4).passwordResetTokenHash).toBeTruthy();
    expect(lines.join("\n")).not.toMatch(/token=/);
  });
});

describe("final review fixes", () => {
  it("I-1: a request that passed the link check after another burned it gets no 2FA guess", async () => {
    db.users[0].twoFactorEnabled = true;
    vi.mocked(E2EAccountService.checkedBundle).mockImplementationOnce(async () => {
      db.users[0].passwordResetTokenHash = null; // a parallel request's wrong code burned the link meanwhile
      return { publicKey: "NEW" } as never;
    });
    expect((await failure(AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET", twoFactorCode: "111111" }))).status).toBe(404);
    expect(TwoFactorService.verify).not.toHaveBeenCalled();
  });

  it("I-1: a wrong code is also told in the app, not only to the inbox", async () => {
    db.users[0].twoFactorEnabled = true;
    await failure(AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET", twoFactorCode: "000000" }));
    expect(vi.mocked(NotificationService.create).mock.calls.some(([id, text]) => id === 3 && /wrong 2FA code/.test(String(text)))).toBe(true);
  });

  it("I-2: people who shared items with Sam are asked to share them again", async () => {
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    const toPat = vi.mocked(NotificationService.create).mock.calls.filter(([id]) => id === 9).map(([, text]) => text);
    expect(toPat.some((text) => /share .*again/i.test(String(text)))).toBe(true);
  });

  it("I-3: an item in someone else's collection, or in Sam's shared one, is kept; expired shares don't count", async () => {
    db.notes.push({ id: 9, userId: 3, companyId: null, e2e: true }, { id: 10, userId: 3, companyId: null, e2e: true });
    db.collections.push({ id: 80, companyId: null, userId: 9, family: false }, { id: 81, companyId: null, userId: 3, family: false, e2eKeyVersion: 1 });
    db.collectionNotes.push({ id: 3, collectionId: 80, noteId: 9 }, { id: 4, collectionId: 81, noteId: 10 });
    db.collectionShares.push({ id: 1, collectionId: 81, sharedWithUserId: 9 });
    db.noteShares.push({ id: 3, noteId: 2, sharedWithUserId: 9, expiresAt: new Date(Date.now() - 1000) });
    const check: any = await AccountResetService.check(TOKEN);
    expect(check.personalItems).toBe(2); // 1, 2
    expect(check.sharedWithOthers).toBe(1); // 1 (2's share expired)
    expect(check.lockedSharedCollections).toBe(1); // 81: its people keep it, Sam can't open it
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect(db.notes.map((note) => note.id)).toEqual(expect.arrayContaining([9, 10]));
    expect(db.collections.map((collection) => collection.id)).toEqual(expect.arrayContaining([80, 81]));
  });

  it("I-4: only Sam's unshared collections with a name locked by the old key are deleted", async () => {
    db.collections.push({ id: 82, companyId: null, userId: 3, family: false, name: "Travel", nameKey: null });
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect(db.collections.map((collection) => collection.id).sort()).toEqual([40, 82]);
  });

  it("F15 I5: resetting from the emailed link confirms the address", async () => {
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect(db.users[0].emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("I-5: a failure after the reset committed still answers success", async () => {
    vi.mocked(AuditService.record).mockRejectedValueOnce(new Error("db down"));
    expect(await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" })).toMatchObject({ userId: 3 });
  });
});

describe("review minors", () => {
  it("M1: a wildcard in the email doesn't send someone else's reset link", async () => {
    vi.spyOn(EmailService, "isConfigured").mockReturnValue(true);
    const send = vi.spyOn(EmailService, "sendAccountResetLink").mockResolvedValue(true as never);
    db.users[0].passwordResetTokenHash = null;
    const AuthService = (await import("@src/services/AuthService")).default;
    await AuthService.requestPasswordReset("%@acme.com");
    await AuthService.requestPasswordReset("sa_@acme.com");
    expect(send).not.toHaveBeenCalled();
    expect(db.users[0].passwordResetTokenHash).toBeNull();
  });

  it("M3: signing in again with the recovery key cancels an emailed reset link", async () => {
    const proof = "A".repeat(43);
    db.users[0].recoveryAuthHash = await bcrypt.hash(proof, 4);
    await E2EAccountService.recoveryComplete({
      email: "sam@acme.com",
      recoveryAuth: proof,
      kdf: { algorithm: "argon2id", memory: 65536, iterations: 3, parallelism: 1, salt: "s".repeat(22) },
      authKey: "B".repeat(43),
      protectedUserKey: `e2e1.${"c".repeat(16)}.${"d".repeat(40)}`,
    });
    expect(db.users[0].passwordResetTokenHash).toBeNull();
  });
});

describe("check", () => {
  it("says what will be lost: personal items, those shared with others, and vaults only Sam holds", async () => {
    expect(await AccountResetService.check(TOKEN)).toEqual({
      email: "sam@acme.com",
      twoFactor: false,
      personalItems: 2,
      sharedWithOthers: 1,
      orphanedVaults: [{ companyName: "Acme", vaultId: 40 }],
      recoveryKeyLost: [],
      familyCollectionLocked: false,
      lockedSharedCollections: 0,
    });
  });

  it("refuses a wrong or expired link", async () => {
    expect((await failure(AccountResetService.check("nope"))).status).toBe(404);
    db.users[0].passwordResetExpires = new Date(Date.now() - 1000);
    expect((await failure(AccountResetService.check(TOKEN))).status).toBe(404);
  });
});

describe("reset", () => {
  it("needs RESET typed", async () => {
    expect((await failure(AccountResetService.reset(TOKEN, { ...bundle, confirm: "reset" }))).status).toBe(400);
  });

  it("needs a 2FA code when the account uses 2FA (a stolen inbox isn't enough)", async () => {
    db.users[0].twoFactorEnabled = true;
    expect((await failure(AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" }))).status).toBe(401);
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET", twoFactorCode: "123456" });
  });

  it("swaps in the new keys, deletes only Sam's personal items, and drops what only the old keys opened", async () => {
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect(db.users[0]).toMatchObject({ publicKey: "NEW", passwordResetTokenHash: null, mustChangeMasterPassword: false });
    expect(db.notes.map((note) => note.id).sort()).toEqual([3, 4]); // company item and someone else's stay
    expect(db.collections.map((collection) => collection.id)).toEqual([40]); // personal collection gone
    expect(db.collectionKeys).toEqual([]);
    expect(db.itemKeys).toEqual([]);
    expect(db.recoveryKeys).toEqual([]); // custodian: a new copy comes from another custodian
    expect(db.passkeys[0].prfUserKey).toBeNull();
    expect(SessionService.revokeAll).toHaveBeenCalledWith(3, undefined, { id: "tx" });
  });

  it("tells Sam, the owners of Sam's companies and whoever has Sam as emergency contact, and logs it", async () => {
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect([...new Set(vi.mocked(NotificationService.create).mock.calls.map(([id]) => id))].sort()).toEqual([1, 3, 9]);
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3, action: "account_reset" }));
  });

  it("works once: the link can't be used again", async () => {
    await AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" });
    expect((await failure(AccountResetService.reset(TOKEN, { ...bundle, confirm: "RESET" }))).status).toBe(404);
  });
});
