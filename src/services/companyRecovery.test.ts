import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sequelize from "@src/configs/DB/sequelize";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import { CompanyRecoveryKey, RecoveryCustodian, RecoveryRequest, VaultRecoveryKey } from "@src/models/CompanyRecovery";
import User from "@src/models/User";
import CompanyRecoveryService from "@src/services/CompanyRecoveryService";
import EmailService from "@src/services/EmailService";
import NotificationService from "@src/services/NotificationService";
import { table } from "@src/services/recoveryTestDb";

const PUBLIC = "A".repeat(43);
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

// Company 7: owner 1 (Olga), admin 2 (Ari), member 3 (Max); all with end-to-end on.
beforeEach(() => {
  vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({ id: "tx" })) as never);
  vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
  vi.spyOn(EmailService, "sendSecurityNotice").mockResolvedValue(true as never);
  db = {
    companies: table(Company, [{ id: 7, name: "Acme", status: "active", recoveryPublicKey: null, recoveryKeyVersion: null, recoveryWaitHours: 24 }]),
    members: table(CompanyMember, [
      { id: 11, companyId: 7, userId: 1, role: "owner", status: "active" },
      { id: 12, companyId: 7, userId: 2, role: "admin", status: "active" },
      { id: 13, companyId: 7, userId: 3, role: "member", status: "active" },
    ]),
    users: table(User, [
      { id: 1, email: "olga@acme.com", e2eEnabled: true, publicKey: PUBLIC },
      { id: 2, email: "ari@acme.com", e2eEnabled: true, publicKey: PUBLIC },
      { id: 3, email: "max@acme.com", e2eEnabled: true, publicKey: PUBLIC },
    ]),
    custodians: table(RecoveryCustodian, []),
    recoveryKeys: table(CompanyRecoveryKey, []),
    vaultKeys: table(VaultRecoveryKey, []),
    requests: table(RecoveryRequest, []),
    collections: table(Collection, []),
    collectionKeys: table(CollectionKey, []),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const turnOn = () => {
  Object.assign(db.companies[0], { recoveryPublicKey: PUBLIC, recoveryKeyVersion: 2 });
  db.custodians.push({ id: 1, companyId: 7, userId: 1 }, { id: 2, companyId: 7, userId: 2 });
  db.recoveryKeys.push(
    { id: 1, companyId: 7, userId: 1, keyVersion: 2, wrappedKey: sealedValue("olga") },
    { id: 2, companyId: 7, userId: 2, keyVersion: 2, wrappedKey: sealedValue("ari") }
  );
};

const keysFor = (ids: number[]) => ids.map((userId) => ({ userId, wrappedKey: sealedValue(`k${userId}`) }));

describe("enable: the owner names custodians", () => {
  it("refuses a single custodian", async () => {
    const err = await failure(
      CompanyRecoveryService.enable(7, 1, { publicKey: PUBLIC, waitHours: 24, custodianIds: [1], keys: keysFor([1]) })
    );
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Name a second custodian/);
  });

  it("refuses a plain member as custodian", async () => {
    const err = await failure(
      CompanyRecoveryService.enable(7, 1, { publicKey: PUBLIC, waitHours: 24, custodianIds: [1, 3], keys: keysFor([1, 3]) })
    );
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/owners or admins/);
  });

  it("refuses a waiting period that isn't 0, 24, 48 or 72 hours", async () => {
    const err = await failure(
      CompanyRecoveryService.enable(7, 1, { publicKey: PUBLIC, waitHours: 12, custodianIds: [1, 2], keys: keysFor([1, 2]) })
    );
    expect(err.status).toBe(400);
  });

  it("turns it on with the owner and an admin, storing the waiting period", async () => {
    await CompanyRecoveryService.enable(7, 1, { publicKey: PUBLIC, waitHours: 48, custodianIds: [1, 2], keys: keysFor([1, 2]) });
    expect(db.companies[0]).toMatchObject({ recoveryPublicKey: PUBLIC, recoveryKeyVersion: 1, recoveryWaitHours: 48 });
    expect(db.custodians.map((row) => row.userId).sort()).toEqual([1, 2]);
    expect(db.recoveryKeys.map((row) => [row.userId, row.keyVersion]).sort()).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });
});

describe("tasks", () => {
  beforeEach(turnOn);

  it("asks a key holder to make the recovery copy of a vault whose key changed", async () => {
    db.collections.push({ id: 40, companyId: 7, e2eKeyVersion: 3 }, { id: 41, companyId: 7, e2eKeyVersion: 1 });
    db.vaultKeys.push({ id: 1, companyId: 7, collectionId: 40, keyVersion: 2, recoveryKeyVersion: 2, wrappedKey: sealedValue("old") });
    // Max (a member) holds vault 40's current key, not vault 41's.
    db.collectionKeys.push({ id: 1, collectionId: 40, userId: 3, keyVersion: 3, wrappedKey: sealedValue("max40") });

    const tasks = await CompanyRecoveryService.tasks(3);

    expect(tasks.continuity).toEqual([
      { companyId: 7, recoveryKeyVersion: 2, recoveryPublicKey: PUBLIC, collectionId: 40, keyVersion: 3, myKey: sealedValue("max40") },
    ]);
    expect(tasks.grant).toEqual([]);
    expect(tasks.rotate).toEqual([]);
  });

  it("replaces the recovery key when a custodian is no longer an owner or admin", async () => {
    db.members[1].role = "member";

    const tasks = await CompanyRecoveryService.tasks(1);

    expect(tasks.rotate).toEqual([{ companyId: 7, keyVersion: 2, custodians: [{ userId: 1, publicKey: PUBLIC }] }]);
  });
});

describe("saveContinuity", () => {
  beforeEach(turnOn);

  it("keeps a copy only for the vault's current key, from someone who holds it", async () => {
    db.collections.push({ id: 40, companyId: 7, e2eKeyVersion: 3 });
    db.collectionKeys.push({ id: 1, collectionId: 40, userId: 3, keyVersion: 3, wrappedKey: sealedValue("max40") });

    const stale = await CompanyRecoveryService.saveContinuity(3, {
      items: [{ collectionId: 40, keyVersion: 2, recoveryKeyVersion: 2, wrappedKey: sealedValue("v2") }],
    });
    expect(stale.saved).toBe(0);
    expect(db.vaultKeys).toHaveLength(0);

    const current = await CompanyRecoveryService.saveContinuity(3, {
      items: [{ collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2, wrappedKey: sealedValue("v3") }],
    });
    expect(current.saved).toBe(1);
    expect(db.vaultKeys[0]).toMatchObject({ companyId: 7, collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2 });
  });
});

describe("settings changes are told to custodians and owners (I3)", () => {
  beforeEach(() => {
    turnOn();
    db.members.push({ id: 14, companyId: 7, userId: 4, role: "admin", status: "active" });
    db.users.push({ id: 4, email: "ada@acme.com", e2eEnabled: true, publicKey: PUBLIC });
  });

  it("a custodian change reaches the new set, the owner and whoever was removed", async () => {
    await CompanyRecoveryService.updateSettings(7, 1, { custodianIds: [1, 4] });
    const told = vi.mocked(NotificationService.create).mock.calls.map(([userId]) => userId).sort();
    expect(told).toEqual([1, 2, 4]);
  });

  it("turning it off is told too", async () => {
    await CompanyRecoveryService.disable(7, 1);
    expect(vi.mocked(NotificationService.create).mock.calls.map(([userId]) => userId).sort()).toEqual([1, 2]);
  });
});

describe("the recovery key can't be lost by mistake (I5)", () => {
  beforeEach(() => {
    turnOn();
    db.members.push(
      { id: 14, companyId: 7, userId: 4, role: "admin", status: "active" },
      { id: 15, companyId: 7, userId: 5, role: "admin", status: "active" }
    );
    db.users.push(
      { id: 4, email: "ada@acme.com", e2eEnabled: true, publicKey: PUBLIC },
      { id: 5, email: "bo@acme.com", e2eEnabled: true, publicKey: PUBLIC }
    );
  });

  it("refuses a custodian set without anyone who holds the key now", async () => {
    const err = await failure(CompanyRecoveryService.updateSettings(7, 1, { custodianIds: [4, 5] }));
    expect(err.status).toBe(409);
    expect(err.message).toBe("Keep at least one custodian who holds the recovery key now.");
  });

  it("says so when no active custodian holds the key any more", async () => {
    db.members[0].role = "member"; // the owner row: demoted for the test
    db.members[1].status = "removed";
    const status: any = await CompanyRecoveryService.status(7, 1);
    expect(status.keyLost).toBe(true);
  });
});

describe("copies are only replaced when needed (M2, M3)", () => {
  beforeEach(turnOn);

  it("keeps a current vault recovery copy instead of overwriting it", async () => {
    db.collections.push({ id: 40, companyId: 7, e2eKeyVersion: 3 });
    db.collectionKeys.push({ id: 1, collectionId: 40, userId: 3, keyVersion: 3, wrappedKey: sealedValue("max40") });
    db.vaultKeys.push({ id: 1, companyId: 7, collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2, wrappedKey: sealedValue("good") });
    const result = await CompanyRecoveryService.saveContinuity(3, {
      items: [{ collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2, wrappedKey: sealedValue("junk") }],
    });
    expect(result.saved).toBe(0);
    expect(db.vaultKeys[0].wrappedKey).toBe(sealedValue("good"));
  });

  it("doesn't replace the recovery key when nobody who left still holds it", async () => {
    const err = await failure(
      CompanyRecoveryService.rotate(1, { companyId: 7, keyVersion: 3, publicKey: PUBLIC, keys: keysFor([1, 2]) })
    );
    expect(err.status).toBe(409);
    expect(db.companies[0].recoveryKeyVersion).toBe(2);
  });

  it("doesn't overwrite a custodian's current copy when granting", async () => {
    await CompanyRecoveryService.grant(1, { companyId: 7, keyVersion: 2, keys: [{ userId: 2, wrappedKey: sealedValue("other") }] });
    expect(db.recoveryKeys.find((row) => row.userId === 2)?.wrappedKey).toBe(sealedValue("ari"));
  });
});

describe("replacing the recovery key keeps vaults nobody holds recoverable (final review C1)", () => {
  beforeEach(turnOn);

  it("keeps their recovery copies and the remaining custodians' copies of the old key; drops the removed custodian's", async () => {
    // Vault 40: nobody holds its key any more; its copy is sealed to recovery key v2.
    db.collections.push({ id: 40, companyId: 7, e2eKeyVersion: 3 });
    db.vaultKeys.push({ id: 1, companyId: 7, collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2, recoveryPublicKey: PUBLIC, wrappedKey: sealedValue("vault40") });
    // Ari (2) stopped being a custodian.
    db.custodians.splice(1, 1);

    await CompanyRecoveryService.rotate(1, { companyId: 7, keyVersion: 3, publicKey: "N".repeat(43), keys: keysFor([1]) });

    expect(db.vaultKeys).toEqual([expect.objectContaining({ collectionId: 40, recoveryKeyVersion: 2, wrappedKey: sealedValue("vault40") })]);
    expect(db.recoveryKeys.map((row) => [row.userId, row.keyVersion]).sort()).toEqual([
      [1, 2],
      [1, 3],
    ]);
    expect(db.companies[0]).toMatchObject({ recoveryKeyVersion: 3, recoveryPublicKey: "N".repeat(43) });
  });

  it("records which public key a new recovery copy is sealed to", async () => {
    db.collections.push({ id: 40, companyId: 7, e2eKeyVersion: 3 });
    db.collectionKeys.push({ id: 1, collectionId: 40, userId: 3, keyVersion: 3, wrappedKey: sealedValue("max40") });
    await CompanyRecoveryService.saveContinuity(3, {
      items: [{ collectionId: 40, keyVersion: 3, recoveryKeyVersion: 2, wrappedKey: sealedValue("v3") }],
    });
    expect(db.vaultKeys[0]).toMatchObject({ recoveryPublicKey: PUBLIC });
  });
});

describe("status", () => {
  beforeEach(turnOn);

  it("shows a plain member who the custodians are, without the owner's candidate list", async () => {
    const status: any = await CompanyRecoveryService.status(7, 3);
    expect(status).toMatchObject({ enabled: true, waitHours: 24, iAmCustodian: false, holdsKey: false });
    expect(status.custodians.map((item: any) => item.email).sort()).toEqual(["ari@acme.com", "olga@acme.com"]);
    expect(status.candidates).toBeUndefined();
  });
});
