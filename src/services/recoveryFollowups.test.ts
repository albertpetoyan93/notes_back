import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sequelize from "@src/configs/DB/sequelize";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import CollectionShare from "@src/models/CollectionShare";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import { CompanyRecoveryKey, RecoveryCustodian, RecoveryRequest, VaultRecoveryKey } from "@src/models/CompanyRecovery";
import ItemKey from "@src/models/ItemKey";
import Note from "@src/models/Note";
import User from "@src/models/User";
import CollectionService from "@src/services/CollectionService";
import CompanyRecoveryService from "@src/services/CompanyRecoveryService";
import EmailService from "@src/services/EmailService";
import NotificationService from "@src/services/NotificationService";
import VaultRecoveryService from "@src/services/VaultRecoveryService";
import { table } from "@src/services/recoveryTestDb";

const PUBLIC = "A".repeat(43);
const GRANTEE_KEY = "G".repeat(43);
const sealedValue = (tag: string) => `e2e1x.${"B".repeat(43)}.${"C".repeat(16)}.${tag.padEnd(40, "D")}`;
const keysFor = (ids: number[]) => ids.map((userId) => ({ userId, wrappedKey: sealedValue(`k${userId}`) }));

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

let db: Record<string, any[]>;
const ask = { collectionId: 40, granteeUserId: 3, permission: "edit", reason: "Ari left; Max takes over" };

// Company 7, recovery on (key v2, no wait). Custodians: owner 1, admin 2. Admin 4 isn't one. Member 3 gets access.
beforeEach(() => {
  vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({ id: "tx" })) as never);
  vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
  vi.spyOn(EmailService, "sendSecurityNotice").mockResolvedValue(true as never);
  vi.spyOn(CollectionService, "getAccess").mockResolvedValue(null as never);
  db = {
    companies: table(Company, [{ id: 7, name: "Acme", status: "active", recoveryPublicKey: PUBLIC, recoveryKeyVersion: 2, recoveryWaitHours: 0 }]),
    members: table(CompanyMember, [
      { id: 11, companyId: 7, userId: 1, role: "owner", status: "active" },
      { id: 12, companyId: 7, userId: 2, role: "admin", status: "active" },
      { id: 13, companyId: 7, userId: 3, role: "member", status: "active" },
      { id: 14, companyId: 7, userId: 4, role: "admin", status: "active" },
    ]),
    users: table(User, [
      { id: 1, email: "olga@acme.com", e2eEnabled: true, publicKey: PUBLIC },
      { id: 2, email: "ari@acme.com", e2eEnabled: true, publicKey: PUBLIC },
      { id: 3, email: "max@acme.com", e2eEnabled: true, publicKey: GRANTEE_KEY },
      { id: 4, email: "ada@acme.com", e2eEnabled: true, publicKey: PUBLIC },
    ]),
    custodians: table(RecoveryCustodian, [
      { id: 1, companyId: 7, userId: 1 },
      { id: 2, companyId: 7, userId: 2 },
    ]),
    recoveryKeys: table(CompanyRecoveryKey, [
      { id: 1, companyId: 7, userId: 1, keyVersion: 2, wrappedKey: sealedValue("olga") },
      { id: 2, companyId: 7, userId: 2, keyVersion: 2, wrappedKey: sealedValue("ari") },
    ]),
    collections: table(Collection, [{ id: 40, companyId: 7, e2eKeyVersion: 3 }]),
    vaultKeys: table(VaultRecoveryKey, [
      { id: 1, companyId: 7, collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2, recoveryPublicKey: PUBLIC, wrappedKey: sealedValue("vault40") },
    ]),
    requests: table(RecoveryRequest, []),
    collectionKeys: table(CollectionKey, []),
    shares: table(CollectionShare, []),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const notified = () => vi.mocked(NotificationService.create).mock.calls.map(([userId]) => userId).sort();

describe("M-a: two rotations at once", () => {
  it("the one that finds the key already replaced writes nothing", async () => {
    db.members[1].role = "member"; // Ari stops counting: a rotation is due
    const findAll = CompanyRecoveryKey.findAll;
    vi.spyOn(CompanyRecoveryKey, "findAll").mockImplementationOnce(async (options: any) => {
      db.companies[0].recoveryKeyVersion = 3; // another custodian's rotation committed here
      return (findAll as any)(options);
    });
    const err = await failure(CompanyRecoveryService.rotate(1, { companyId: 7, keyVersion: 3, publicKey: "N".repeat(43), keys: keysFor([1]) }));
    expect(err.status).toBe(409);
    expect(db.recoveryKeys.some((row) => row.wrappedKey === sealedValue("k1"))).toBe(false);
  });
});

describe("M1: a custodian who stopped being an owner or admin", () => {
  it("is dropped as custodian when the key is replaced, so promoting them again doesn't make them one", async () => {
    db.members[1].role = "member";
    await CompanyRecoveryService.rotate(1, { companyId: 7, keyVersion: 3, publicKey: "N".repeat(43), keys: keysFor([1]) });
    expect(db.custodians.map((row) => row.userId)).toEqual([1]);
  });

  it("shows in the status until then, so the owner sees them", async () => {
    db.members[1].role = "member";
    const status: any = await CompanyRecoveryService.status(7, 1);
    expect(status.inactiveCustodians).toEqual([{ userId: 2, email: "ari@acme.com" }]);
  });
});

describe("M-e: settings are checked before anything is saved", () => {
  it("a bad custodian set leaves the waiting period unchanged", async () => {
    const err = await failure(CompanyRecoveryService.updateSettings(7, 1, { waitHours: 48, custodianIds: [1] }));
    expect(err.status).toBe(409);
    expect(db.companies[0].recoveryWaitHours).toBe(0);
  });
});

describe("M-f: a requester who isn't a custodian or owner is told", () => {
  it("about approval and completion", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    vi.mocked(NotificationService.create).mockClear();
    await VaultRecoveryService.approve(7, 2, request.id);
    expect(notified()).toContain(4);
    vi.mocked(NotificationService.create).mockClear();
    await VaultRecoveryService.complete(7, 1, request.id, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY });
    expect(notified()).toContain(4);
  });
});

describe("M-d: completing doesn't replace a key the person already has", () => {
  it("keeps their current copy", async () => {
    db.collectionKeys.push({ id: 9, collectionId: 40, userId: 3, keyVersion: 3, wrappedKey: sealedValue("theirs") });
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    await VaultRecoveryService.complete(7, 1, request.id, { keyVersion: 3, wrappedKey: sealedValue("other"), granteePublicKey: GRANTEE_KEY });
    expect(db.collectionKeys).toEqual([expect.objectContaining({ userId: 3, wrappedKey: sealedValue("theirs") })]);
  });
});

describe("M-c: what the request form may offer", () => {
  it("status lists the vaults that can be recovered now", async () => {
    db.collections.push({ id: 41, companyId: 7, e2eKeyVersion: 1 }); // no copy
    const status: any = await CompanyRecoveryService.status(7, 1);
    expect(status.recoverableVaultIds).toEqual([40]);
  });

  it("the members list says who has end-to-end encryption on", async () => {
    db.users[2].e2eEnabled = false;
    vi.spyOn(Company, "findByPk").mockResolvedValue({ id: 7, status: "active" } as never);
    const CompanyService = (await import("@src/services/CompanyService")).default;
    const members: any[] = await CompanyService.members(7, 1);
    expect(members.find((row) => row.userId === 3)).toMatchObject({ e2eEnabled: false });
    expect(members.find((row) => row.userId === 1)).toMatchObject({ e2eEnabled: true });
  });
});

describe("M-g: a damaged recovery copy is caught before it gives a wrong key", () => {
  beforeEach(() => {
    table(ItemKey, [{ id: 1, noteId: 81, containerType: "collection", containerId: 40, keyVersion: 3, wrappedKey: sealedValue("item81") }]);
    table(Note, [{ id: 81, e2eId: "e2e-81" }]);
  });

  it("the recovery material carries one value the vault key must open", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    const material: any = await VaultRecoveryService.material(7, 1, request.id);
    expect(material.check).toEqual({ kind: "item", e2eId: "e2e-81", wrappedKey: sealedValue("item81") });
  });

  it("a custodian ready to complete can drop the damaged copy they were given, when a key holder can re-make it", async () => {
    db.collectionKeys.push({ id: 5, collectionId: 40, userId: 2, keyVersion: 3, wrappedKey: sealedValue("ari40") });
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    vi.mocked(NotificationService.create).mockClear();
    await VaultRecoveryService.dropCopy(7, 1, request.id, 1);
    expect(db.vaultKeys).toHaveLength(0);
    expect(notified()).toEqual([1, 2, 4]);
  });

  it("can't drop a copy before the request is approved and ready (mid review I1)", async () => {
    db.collectionKeys.push({ id: 5, collectionId: 40, userId: 2, keyVersion: 3, wrappedKey: sealedValue("ari40") });
    const request = await VaultRecoveryService.create(7, 1, ask);
    expect((await failure(VaultRecoveryService.dropCopy(7, 1, request.id, 1))).status).toBe(409);
    expect(db.vaultKeys).toHaveLength(1);
  });

  it("keeps the copy of a vault nobody holds (it can't be re-made)", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    const err = await failure(VaultRecoveryService.dropCopy(7, 1, request.id, 1));
    expect(err.status).toBe(409);
    expect(db.vaultKeys).toHaveLength(1);
  });

  it("keeps the copy when the only key holder has left the company (final review I-A)", async () => {
    // Max (3) holds vault 40's key but was removed: he keeps the key row, yet can never re-make the copy.
    db.collectionKeys.push({ id: 5, collectionId: 40, userId: 3, keyVersion: 3, wrappedKey: sealedValue("max40") });
    const request = await VaultRecoveryService.create(7, 4, { ...ask, granteeUserId: 4 });
    await VaultRecoveryService.approve(7, 2, request.id);
    db.members[2].status = "removed";
    const err = await failure(VaultRecoveryService.dropCopy(7, 1, request.id, 1));
    expect(err.status).toBe(409);
    expect(db.vaultKeys).toHaveLength(1);
  });

  it("doesn't drop a copy that was re-made since (only the one the custodian checked)", async () => {
    db.collectionKeys.push({ id: 5, collectionId: 40, userId: 2, keyVersion: 3, wrappedKey: sealedValue("ari40") });
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    expect((await failure(VaultRecoveryService.dropCopy(7, 1, request.id, 999))).status).toBe(409);
    expect(db.vaultKeys).toHaveLength(1);
  });

  it("is refused for someone who isn't a custodian", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    expect((await failure(VaultRecoveryService.dropCopy(7, 4, request.id, 1))).status).toBe(403);
  });
});

describe("mid review I2: demoting or removing a custodian ends their custody at once", () => {
  it("making them a member drops their custodian entry", async () => {
    vi.spyOn(Company, "findByPk").mockResolvedValue({ id: 7, status: "active" } as never);
    const CompanyService = (await import("@src/services/CompanyService")).default;
    await CompanyService.updateMemberRole(7, 1, 12, "member");
    expect(db.custodians.map((row) => row.userId)).toEqual([1]);
  });
});

describe("mid review m4: status shows recovery details only to owners, admins and custodians", () => {
  it("a plain member gets no vault list and no inactive custodians", async () => {
    const status: any = await CompanyRecoveryService.status(7, 3);
    expect(status.recoverableVaultIds).toEqual([]);
    expect(status.inactiveCustodians).toEqual([]);
  });
});

describe("mid review m2: one bad recovery copy doesn't fail the batch", () => {
  it("saves the others when one item errors", async () => {
    db.collections.push({ id: 41, companyId: 7, e2eKeyVersion: 1 });
    db.collectionKeys.push(
      { id: 6, collectionId: 41, userId: 3, keyVersion: 1, wrappedKey: sealedValue("max41") },
      { id: 7, collectionId: 40, userId: 3, keyVersion: 3, wrappedKey: sealedValue("max40") }
    );
    db.vaultKeys.splice(0, 1); // vault 40 needs a copy too
    const create = VaultRecoveryKey.create;
    vi.spyOn(VaultRecoveryKey, "create").mockImplementationOnce(async () => {
      throw new Error("unique violation");
    });
    vi.mocked(VaultRecoveryKey.create).mockImplementation(create as never);
    const result = await CompanyRecoveryService.saveContinuity(3, {
      items: [
        { collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2, wrappedKey: sealedValue("c40") },
        { collectionId: 41, keyVersion: 1, recoveryKeyVersion: 2, wrappedKey: sealedValue("c41") },
      ],
    });
    expect(result.saved).toBe(1);
    expect(db.vaultKeys.map((row) => row.collectionId)).toEqual([41]);
  });
});

describe("mid review m7: requests whose vault or person was deleted", () => {
  it("can't be approved, with a clear reason", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    db.requests[0].collectionId = null;
    const err = await failure(VaultRecoveryService.approve(7, 2, request.id));
    expect(err.status).toBe(409);
    expect(err.message).toBe("The vault or the person in this request was deleted. Cancel it.");
  });
});

describe("M7: request history", () => {
  it("can still be read after recovery is turned off", async () => {
    await VaultRecoveryService.create(7, 4, ask);
    await CompanyRecoveryService.disable(7, 1);
    const rows = await VaultRecoveryService.list(7, 1);
    expect(rows).toEqual([expect.objectContaining({ status: "cancelled", granteeEmail: "max@acme.com" })]);
  });

  it("shows a deleted person as (deleted)", async () => {
    await VaultRecoveryService.create(7, 4, ask);
    db.requests[0].granteeUserId = null;
    const rows = await VaultRecoveryService.list(7, 1);
    expect(rows[0].granteeEmail).toBe("(deleted)");
  });
});
