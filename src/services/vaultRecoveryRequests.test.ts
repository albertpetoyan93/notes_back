import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sequelize from "@src/configs/DB/sequelize";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import CollectionShare from "@src/models/CollectionShare";
import ItemKey from "@src/models/ItemKey";
import Note from "@src/models/Note";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import { CompanyRecoveryKey, RecoveryCustodian, RecoveryRequest, VaultRecoveryKey } from "@src/models/CompanyRecovery";
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

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

let db: Record<string, any[]>;
const ask = { collectionId: 40, granteeUserId: 3, permission: "edit", reason: "Ari left; Max takes over the servers" };

// Company 7, recovery on (key v2, 24 h). Custodians: owner 1 and admin 2. Admin 4 isn't one. Member 3 is the grantee.
beforeEach(() => {
  vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({ id: "tx" })) as never);
  vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
  vi.spyOn(EmailService, "sendSecurityNotice").mockResolvedValue(true as never);
  vi.spyOn(CollectionService, "getAccess").mockResolvedValue(null as never);
  db = {
    companies: table(Company, [{ id: 7, name: "Acme", status: "active", recoveryPublicKey: PUBLIC, recoveryKeyVersion: 2, recoveryWaitHours: 24 }]),
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
    collections: table(Collection, [
      { id: 40, companyId: 7, e2eKeyVersion: 3 },
      { id: 41, companyId: 7, e2eKeyVersion: 1 },
    ]),
    vaultKeys: table(VaultRecoveryKey, [
      { id: 1, companyId: 7, collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2, recoveryPublicKey: PUBLIC, wrappedKey: sealedValue("vault40") },
    ]),
    requests: table(RecoveryRequest, []),
    collectionKeys: table(CollectionKey, []),
    shares: table(CollectionShare, []),
    // An empty vault: nothing to check the opened key against.
    itemKeys: table(ItemKey, []),
    notes: table(Note, []),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const notified = () => vi.mocked(NotificationService.create).mock.calls.map(([userId]) => userId).sort();

describe("create", () => {
  it("is for owners and admins only", async () => {
    expect((await failure(VaultRecoveryService.create(7, 3, ask))).status).toBe(403);
  });

  it("needs a reason", async () => {
    expect((await failure(VaultRecoveryService.create(7, 1, { ...ask, reason: " x " }))).status).toBe(400);
  });

  it("needs the vault's recovery copy", async () => {
    const err = await failure(VaultRecoveryService.create(7, 1, { ...ask, collectionId: 41 }));
    expect(err.status).toBe(409);
    expect(err.message).toBe("This vault has no recovery copy yet.");
  });

  it("opens a request with the waiting period, tells custodians and owners, and allows only one open per vault and person", async () => {
    const before = Date.now();
    const request = await VaultRecoveryService.create(7, 4, ask);
    expect(request).toMatchObject({ status: "pending", requestedBy: 4, granteeUserId: 3, permission: "edit" });
    expect(request.availableAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 3600 * 1000);
    expect(notified()).toEqual([1, 2]);
    expect((await failure(VaultRecoveryService.create(7, 1, ask))).status).toBe(409);
  });
});

describe("approve", () => {
  it("can't be done by the person who asked, even a custodian (Review Focus 4)", async () => {
    const request = await VaultRecoveryService.create(7, 1, ask);
    const err = await failure(VaultRecoveryService.approve(7, 1, request.id));
    expect(err.status).toBe(403);
    expect(err.message).toBe("Someone else must approve this.");
  });

  it("is for custodians only", async () => {
    const request = await VaultRecoveryService.create(7, 1, ask);
    expect((await failure(VaultRecoveryService.approve(7, 4, request.id))).status).toBe(403);
    const approved = await VaultRecoveryService.approve(7, 2, request.id);
    expect(approved).toMatchObject({ status: "approved", approvedBy: 2 });
  });
});

describe("material", () => {
  it("waits for the waiting period", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    const err = await failure(VaultRecoveryService.material(7, 1, request.id));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/^Not ready until /);
  });

  it("with no waiting period, is ready once approved", async () => {
    db.companies[0].recoveryWaitHours = 0;
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    const material = await VaultRecoveryService.material(7, 1, request.id);
    expect(material).toEqual({
      copyId: 1,
      check: null,
      recoveryKeyVersion: 2,
      recoveryPublicKey: PUBLIC,
      myKey: sealedValue("olga"),
      vault: { collectionId: 40, keyVersion: 3, wrappedKey: sealedValue("vault40") },
      grantee: { userId: 3, publicKey: GRANTEE_KEY },
    });
  });

  it("after the recovery key was replaced, uses the vault's older copy with the custodian's copy of that older key (C1)", async () => {
    db.companies[0].recoveryWaitHours = 0;
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    // Replaced: v3 is current; Olga (1) still holds v2, and the vault's copy is sealed to v2.
    Object.assign(db.companies[0], { recoveryKeyVersion: 3, recoveryPublicKey: "N".repeat(43) });
    db.recoveryKeys.push({ id: 3, companyId: 7, userId: 1, keyVersion: 3, wrappedKey: sealedValue("olga-v3") });
    const material = await VaultRecoveryService.material(7, 1, request.id);
    expect(material).toMatchObject({ recoveryKeyVersion: 2, recoveryPublicKey: PUBLIC, myKey: sealedValue("olga") });
  });

  it("refuses a custodian who doesn't hold the older key the vault's copy needs (Review Focus 2)", async () => {
    db.companies[0].recoveryWaitHours = 0;
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    Object.assign(db.companies[0], { recoveryKeyVersion: 3, recoveryPublicKey: "N".repeat(43) });
    db.recoveryKeys.forEach((row) => (row.keyVersion = 3));
    const err = await failure(VaultRecoveryService.material(7, 1, request.id));
    expect(err.status).toBe(409);
    expect(err.message).toBe("This vault's recovery copy needs an earlier recovery key you don't hold. A custodian who held it can complete this.");
  });
});

describe("waiting period", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at approval, so a request left pending doesn't become ready the moment it's approved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T08:00:00Z"));
    const request = await VaultRecoveryService.create(7, 4, ask);
    vi.setSystemTime(new Date("2026-11-12T08:00:00Z")); // two days later
    const approved = await VaultRecoveryService.approve(7, 2, request.id);
    expect(approved.availableAt.toISOString()).toBe("2026-11-13T08:00:00.000Z");
    expect((await failure(VaultRecoveryService.material(7, 1, request.id))).message).toMatch(/^Not ready until /);
  });
});

describe("races between people acting at once", () => {
  beforeEach(() => {
    db.companies[0].recoveryWaitHours = 0;
  });

  it("an approval doesn't bring back a request cancelled meanwhile", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    const custodians = CompanyRecoveryService.activeCustodianIds.bind(CompanyRecoveryService);
    vi.spyOn(CompanyRecoveryService, "activeCustodianIds").mockImplementationOnce(async (companyId: number) => {
      db.requests[0].status = "cancelled"; // another custodian's cancel lands here
      return custodians(companyId);
    });
    expect((await failure(VaultRecoveryService.approve(7, 2, request.id))).status).toBe(409);
    expect(db.requests[0].status).toBe("cancelled");
  });

  it("a request cancelled while it's being completed hands nothing over", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    vi.mocked(CollectionService.getAccess).mockImplementationOnce(async () => {
      db.requests[0].status = "cancelled";
      return null as never;
    });
    const err = await failure(
      VaultRecoveryService.complete(7, 1, request.id, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY })
    );
    expect(err.status).toBe(409);
    expect(db.collectionKeys).toHaveLength(0);
    expect(db.shares).toHaveLength(0);
    expect(db.requests[0].status).toBe("cancelled");
  });

  it("a cancel after it was completed doesn't rewrite the record", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    const custodians = CompanyRecoveryService.activeCustodianIds.bind(CompanyRecoveryService);
    vi.spyOn(CompanyRecoveryService, "activeCustodianIds").mockImplementationOnce(async (companyId: number) => {
      db.requests[0].status = "completed";
      return custodians(companyId);
    });
    expect((await failure(VaultRecoveryService.cancel(7, 1, request.id))).status).toBe(409);
    expect(db.requests[0].status).toBe("completed");
  });

  it("a vault key replaced while completing is caught inside the transaction (Review Focus 1)", async () => {
    const request = await VaultRecoveryService.create(7, 4, ask);
    await VaultRecoveryService.approve(7, 2, request.id);
    vi.mocked(CollectionService.getAccess).mockImplementationOnce(async () => {
      db.collections[0].e2eKeyVersion = 4; // a rotation commits here
      return null as never;
    });
    const err = await failure(
      VaultRecoveryService.complete(7, 1, request.id, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY })
    );
    expect(err.status).toBe(409);
    expect(db.collectionKeys).toHaveLength(0);
  });
});

describe("request ids", () => {
  it("a request id that isn't a number is simply not found", async () => {
    expect((await failure(VaultRecoveryService.approve(7, 2, Number("abc")))).status).toBe(404);
  });
});

describe("complete", () => {
  let requestId: number;

  beforeEach(async () => {
    db.companies[0].recoveryWaitHours = 0;
    requestId = (await VaultRecoveryService.create(7, 4, ask)).id;
    await VaultRecoveryService.approve(7, 2, requestId);
    vi.mocked(NotificationService.create).mockClear();
  });

  it("refuses a key of an old vault key version and writes nothing (Review Focus 1)", async () => {
    const err = await failure(
      VaultRecoveryService.complete(7, 1, requestId, { keyVersion: 2, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY })
    );
    expect(err.status).toBe(409);
    expect(err.message).toBe("The vault's key changed. Try again.");
    expect(db.collectionKeys).toHaveLength(0);
  });

  it("needs the public key the vault key was sealed to", async () => {
    expect((await failure(VaultRecoveryService.complete(7, 1, requestId, { keyVersion: 3, wrappedKey: sealedValue("for-max") }))).status).toBe(400);
  });

  it("refuses when the person was suspended meanwhile, and the request stays approved (Review Focus 3)", async () => {
    db.members[2].status = "suspended";
    expect(
      (await failure(VaultRecoveryService.complete(7, 1, requestId, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY }))).status
    ).toBe(409);
    expect(db.requests[0].status).toBe("approved");
  });

  it("refuses when the person left the company meanwhile (Review Focus 3)", async () => {
    db.members.splice(2, 1);
    expect(
      (await failure(VaultRecoveryService.complete(7, 1, requestId, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY }))).status
    ).toBe(409);
  });

  it("makes an expiring share the person already has permanent, at the requested access", async () => {
    db.shares.push({ id: 5, collectionId: 40, sharedByUserId: 1, sharedWithUserId: 3, permission: "edit", expiresAt: new Date("2026-12-01") });
    vi.mocked(CollectionService.getAccess).mockResolvedValueOnce({ permission: "edit" } as never);
    await VaultRecoveryService.complete(7, 1, requestId, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY });
    expect(db.shares[0]).toMatchObject({ permission: "edit", expiresAt: null });
  });

  it("ADR-002 I1: the recovered access is a 'recovery' grant, and a manager when the vault has none", async () => {
    await VaultRecoveryService.complete(7, 1, requestId, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY });
    expect(db.shares[0]).toMatchObject({ sharedWithUserId: 3, source: "recovery", manages: true });
  });

  it("ADR-002 I1: even when they reached it already (everyone/group), and not a manager when one is active", async () => {
    db.shares.push({ id: 6, collectionId: 40, sharedByUserId: 1, sharedWithUserId: 2, permission: "edit", manages: true, source: "admin_legacy", expiresAt: null });
    vi.mocked(CollectionService.getAccess).mockResolvedValueOnce({ permission: "edit" } as never);
    await VaultRecoveryService.complete(7, 1, requestId, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY });
    expect(db.shares.find((row) => row.sharedWithUserId === 3)).toMatchObject({ source: "recovery", manages: false });
  });

  it("gives the person the vault key and access, and tells them", async () => {
    const done = await VaultRecoveryService.complete(7, 1, requestId, { keyVersion: 3, wrappedKey: sealedValue("for-max"), granteePublicKey: GRANTEE_KEY });
    expect(done).toMatchObject({ status: "completed", completedBy: 1 });
    expect(db.collectionKeys).toEqual([
      expect.objectContaining({ collectionId: 40, userId: 3, keyVersion: 3, wrappedKey: sealedValue("for-max"), grantedBy: 1 }),
    ]);
    expect(db.shares).toEqual([expect.objectContaining({ collectionId: 40, sharedWithUserId: 3, permission: "edit", sharedByUserId: 1 })]);
    // Custodians and owner (1, 2), the person (3), and the admin who asked (4).
    expect(notified()).toEqual([1, 2, 3, 4]);
  });
});
