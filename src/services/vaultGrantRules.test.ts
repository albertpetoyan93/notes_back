import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StripeService from "@src/services/StripeService";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import CollectionShare from "@src/models/CollectionShare";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import User from "@src/models/User";
import AuditService from "@src/services/AuditService";
import CollectionService from "@src/services/CollectionService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import CompanyService from "@src/services/CompanyService";
import { RecoveryCustodian } from "@src/models/CompanyRecovery";
import GroupService from "@src/services/GroupService";
import { CollectionGroupShare, CompanyGroup, CompanyGroupMember, GroupRequest } from "@src/models/CompanyGroup";
import NoteService from "@src/services/NoteService";
import E2EItemService from "@src/services/E2EItemService";
import sequelize from "@src/configs/DB/sequelize";
import NotificationService from "@src/services/NotificationService";
import { table } from "@src/services/recoveryTestDb";

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

let db: Record<string, any[]>;

// Acme (7): Olga owner (1), Ade admin (2, no grant), Mo member (3) manages vault 41 alone, Lu member (4).
beforeEach(() => {
  vi.spyOn(CompanyPolicyService, "forUser").mockResolvedValue({ blocked: new Set<number>() } as never);
  vi.spyOn(GroupService, "forUser").mockResolvedValue(new Map() as never);
  vi.spyOn(GroupService, "sharesOf").mockResolvedValue(new Map() as never);
  vi.spyOn(CollectionService as any, "noteCounts").mockResolvedValue(new Map());
  vi.spyOn(AuditService, "record").mockResolvedValue(undefined as never);
  vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
  db = {
    users: table(User, [
      { id: 1, email: "olga@acme.com", emailVerifiedAt: new Date("2026-01-01") },
      { id: 2, email: "ade@acme.com", emailVerifiedAt: new Date("2026-01-01") },
      { id: 3, email: "mo@acme.com", emailVerifiedAt: new Date("2026-01-01") },
      { id: 4, email: "lu@acme.com", emailVerifiedAt: new Date("2026-01-01") },
    ]),
    companies: table(Company, [{ id: 7, name: "Acme", status: "active" }]),
    members: table(CompanyMember, [
      { id: 11, companyId: 7, userId: 1, role: "owner", status: "active" },
      { id: 12, companyId: 7, userId: 2, role: "admin", status: "active" },
      { id: 13, companyId: 7, userId: 3, role: "member", status: "active" },
      { id: 14, companyId: 7, userId: 4, role: "member", status: "active" },
    ]),
    collections: table(Collection, [{ id: 41, companyId: 7, userId: 1, name: "Dev", companyShare: null }]),
    shares: table(CollectionShare, [
      { id: 2, collectionId: 41, sharedByUserId: 1, sharedWithUserId: 3, permission: "edit", manages: true, source: "direct", expiresAt: null },
    ]),
    keys: table(CollectionKey, []),
    custodians: table(RecoveryCustodian, []),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managing vault grants", () => {
  it("SEC06: a manager the company's 2FA rule blocks can't share the vault or get its key tasks", async () => {
    vi.mocked(CompanyPolicyService.forUser).mockResolvedValue({ blocked: new Set<number>([7]) } as never);
    expect((await failure(CollectionService.shareCompanyCollection(7, 41, 3, "people", "view", ["lu@acme.com"]))).status).toBe(403);
    expect((await (E2EItemService as any).managedCollections(3)).map((row: any) => row.id)).not.toContain(41);
  });

  it("SEC06: replacing a vault's key needs the current key (a manager without it can't wipe the items)", async () => {
    vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({ id: "tx", LOCK: { UPDATE: "UPDATE" } })) as never);
    vi.spyOn(GroupService, "byCollection").mockResolvedValue(new Map() as never);
    db.collections[0].e2eKeyVersion = 1;
    db.users[2].publicKey = "PK";
    const rotate = () => E2EItemService.rotate(3, 41, { keyVersion: 2, keys: [{ userId: 3, wrappedKey: "x" }], items: [] });
    expect(await failure(rotate())).toMatchObject({ status: 409, message: "You need the vault's current key to replace it." });
  });

  it("SEC06: the owner's company export holds only the vaults the owner can open", async () => {
    db.collections.push({ id: 42, companyId: 7, userId: 3, name: "Finance", companyShare: null });
    db.shares.push({ id: 30, collectionId: 41, sharedByUserId: 3, sharedWithUserId: 1, permission: "view", manages: false, source: "direct", expiresAt: null });
    const asked = vi.spyOn(CollectionService, "noteIdsForCollections").mockResolvedValue([]);
    await NoteService.exportCompany(7, 1);
    expect(asked.mock.calls[0][0]).toEqual([41]);
  });

  describe("SEC06: an admin reaching a vault another way is logged like \"Give me access\"", () => {
    const selfGranted = () =>
      vi.mocked(AuditService.record).mock.calls.filter(([entry]: any[]) => entry.action === "vault_self_granted").map(([entry]: any[]) => entry);
    beforeEach(() => {
      table(CompanyGroup, [{ id: 5, companyId: 7, name: "Ops" }]);
      table(CompanyGroupMember, [{ id: 1, groupId: 5, userId: 2 }]);
      table(CollectionGroupShare, []);
      table(GroupRequest, []);
    });

    it("sharing a vault with all members", async () => {
      await CollectionService.shareCompanyCollection(7, 41, 2, "all", "view");
      expect(selfGranted()).toEqual([expect.objectContaining({ actorId: 2, collectionId: 41, companyId: 7 })]);
      expect(vi.mocked(NotificationService.create).mock.calls.map(([id]) => id)).toEqual([3]);
    });

    it("sharing a vault with a group they're in", async () => {
      await GroupService.shareCollection(7, 2, 41, 5, "edit");
      expect(selfGranted()).toEqual([expect.objectContaining({ actorId: 2, collectionId: 41 })]);
    });

    it("adding themselves to a group that has the vault", async () => {
      db.groupMembers = table(CompanyGroupMember, []);
      table(CollectionGroupShare, [{ id: 1, collectionId: 41, groupId: 5, permission: "view" }]);
      await GroupService.addMembers(7, 2, 5, [2]);
      expect(selfGranted()).toEqual([expect.objectContaining({ actorId: 2, collectionId: 41 })]);
    });

    it("a manager who already has the vault isn't logged as self-granting", async () => {
      await CollectionService.shareCompanyCollection(7, 41, 3, "all", "view");
      expect(selfGranted()).toEqual([]);
    });
  });

  it("SEC06: someone who can only view a vault can't write its keys; a manager or editor can", async () => {
    vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn({ id: "tx", LOCK: { UPDATE: "UPDATE" } })) as never);
    vi.spyOn(GroupService, "byCollection").mockResolvedValue(new Map() as never);
    db.shares.push({ id: 9, collectionId: 41, sharedByUserId: 3, sharedWithUserId: 4, permission: "view", manages: false, source: "direct", expiresAt: null });
    const firstKey = { collections: [{ collectionId: 41, keyVersion: 1, create: true, keys: [] }] };
    expect(await failure(E2EItemService.applyKeys(4, firstKey))).toMatchObject({ status: 403 });
    // The manager gets past the check (and is then told the key must reach everyone).
    expect((await failure(E2EItemService.applyKeys(3, firstKey))).status).toBe(409);
  });

  it("SEC06: the company item list holds only vaults the person can open, not every vault an admin sees", async () => {
    vi.spyOn(NoteService as any, "purgeOldTrash").mockResolvedValue(undefined);
    vi.spyOn(NoteService as any, "getAccessMaps").mockResolvedValue({ sharedNoteIds: [], permissionByNoteId: new Map(), ownedCollectionIds: [] });
    // Stops right after the vaults are chosen; the rest of the list isn't under test here.
    const asked = vi.spyOn(CollectionService, "noteIdsForCollections").mockRejectedValue(new Error("chosen"));
    for (const [userId, filters] of [[2, { companyId: 7 }], [2, { companyId: 7, collectionId: 41 }], [3, { companyId: 7 }]] as const) {
      await NoteService.getNotes(userId, filters as never).catch((error) => expect(error.message).toBe("chosen"));
    }
    expect(asked.mock.calls.map(([ids]) => ids)).toEqual([[], [], [41]]);
  });

  it("an admin gives themselves access: logged, the managers told, marked as self-given", async () => {
    await CollectionService.selfGrant(7, 41, 2, "view");
    expect(db.shares.find((row) => row.sharedWithUserId === 2)).toMatchObject({ permission: "view", source: "self", manages: false });
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: "vault_self_granted", collectionId: 41 }));
    expect(vi.mocked(NotificationService.create).mock.calls.map(([id]) => id)).toEqual([3]);
  });

  it("a plain member can't give themselves access", async () => {
    expect((await failure(CollectionService.selfGrant(7, 41, 4, "view"))).status).toBe(403);
  });

  it("a vault manager (member role) may share their vault, and make someone manager", async () => {
    await CollectionService.shareCompanyCollection(7, 41, 3, "people", "view", ["lu@acme.com"], true);
    expect(db.shares.find((row) => row.sharedWithUserId === 4)).toMatchObject({ permission: "view", manages: true });
  });

  it("a plain member without manager rights gets 403", async () => {
    db.shares.push({ id: 3, collectionId: 41, sharedByUserId: 3, sharedWithUserId: 4, permission: "edit", manages: false, source: "direct", expiresAt: null });
    expect((await failure(CollectionService.shareCompanyCollection(7, 41, 4, "people", "view", ["olga@acme.com"]))).status).toBe(403);
  });

  it("the last manager can't be removed or stop managing (409)", async () => {
    const last = "A vault needs at least one manager.";
    expect(await failure(CollectionService.setManager(7, 41, 1, 3, false))).toMatchObject({ status: 409, message: last });
    expect(await failure(CollectionService.unshareCompanyCollection(7, 41, 1, { memberUserId: 3 }))).toMatchObject({ status: 409, message: last });
  });

  it("with a second manager, one can stop managing (logged)", async () => {
    db.shares.push({ id: 3, collectionId: 41, sharedByUserId: 3, sharedWithUserId: 4, permission: "edit", manages: false, source: "direct", expiresAt: null });
    await CollectionService.setManager(7, 41, 3, 4, true);
    await CollectionService.setManager(7, 41, 1, 3, false);
    expect(db.shares.find((row) => row.sharedWithUserId === 3)?.manages).toBe(false);
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: "vault_manager_changed", targetUserId: 3 }));
  });

  it("I2: someone a personal collection is shared with can't list who else has it", async () => {
    db.collections.push({ id: 50, companyId: null, userId: 1, name: "Home" });
    db.shares.push({ id: 9, collectionId: 50, sharedByUserId: 1, sharedWithUserId: 4, permission: "view", manages: false, source: "direct", expiresAt: null });
    expect(await CollectionService.listShares(50, 4)).toBeNull();
  });

  it("I4: an admin made member loses legacy grants where another manager remains", async () => {
    vi.spyOn(CompanyService as any, "requireOwner").mockResolvedValue(undefined);
    db.collections.push({ id: 42, companyId: 7, userId: 1, name: "Ops", companyShare: null });
    db.shares.push(
      { id: 10, collectionId: 41, sharedByUserId: 2, sharedWithUserId: 2, permission: "edit", manages: true, source: "admin_legacy", expiresAt: null },
      { id: 11, collectionId: 42, sharedByUserId: 2, sharedWithUserId: 2, permission: "edit", manages: true, source: "admin_legacy", expiresAt: null }
    );
    await CompanyService.updateMemberRole(7, 1, 12, "member");
    // 41 keeps Mo as manager, so Ade's legacy grant goes; 42 would have nobody, so it stays.
    expect(db.shares.filter((row) => row.sharedWithUserId === 2).map((row) => row.collectionId)).toEqual([42]);
  });

  it("I5: sharing a vault to yourself isn't a way around the logged self-grant", async () => {
    const result = await CollectionService.shareCompanyCollection(7, 41, 2, "people", "edit", ["ade@acme.com"]);
    expect(result.failed).toEqual([{ email: "ade@acme.com", message: "Use “Give me access” for yourself (it's logged)." }]);
    expect(db.shares.find((row) => row.sharedWithUserId === 2)).toBeUndefined();
  });

  it("I-A: re-sharing to someone doesn't quietly take away their manager role", async () => {
    await CollectionService.shareCompanyCollection(7, 41, 1, "people", "edit", ["mo@acme.com"], false);
    expect(db.shares.find((row) => row.sharedWithUserId === 3)).toMatchObject({ permission: "edit", manages: true });
  });

  it("I-B: a former admin who joins again as a member doesn't get admin-era grants back", async () => {
    vi.spyOn(StripeService, "syncSeatsLater").mockImplementation(() => undefined as never);
    vi.spyOn(CompanyPolicyService, "clear").mockImplementation(() => undefined as never);
    vi.spyOn(CompanyService as any, "summary").mockResolvedValue({ id: 7 });
    db.users.push({ id: 5, email: "ann@acme.com", emailVerifiedAt: new Date("2026-01-01") });
    db.members.push({
      id: 15, companyId: 7, userId: 5, email: "ann@acme.com", role: "member", status: "invited", expiresAt: null,
      inviteTokenHash: crypto.createHash("sha256").update("t").digest("hex"), inviteEmailed: true,
    });
    db.shares.push({ id: 20, collectionId: 41, sharedByUserId: 5, sharedWithUserId: 5, permission: "edit", manages: true, source: "admin_legacy", expiresAt: null });
    await CompanyService.accept(7, 5, "t");
    expect(db.shares.find((row) => row.sharedWithUserId === 5)).toBeUndefined();
  });

  it("I-C: demotion puts back a share the migration raised (view, not a manager)", async () => {
    vi.spyOn(CompanyService as any, "requireOwner").mockResolvedValue(undefined);
    db.shares.push({
      id: 21, collectionId: 41, sharedByUserId: 1, sharedWithUserId: 2, permission: "edit", manages: true, source: "direct",
      priorPermission: "view", priorManages: false, expiresAt: null,
    });
    await CompanyService.updateMemberRole(7, 1, 12, "member");
    expect(db.shares.find((row) => row.sharedWithUserId === 2)).toMatchObject({ permission: "view", manages: false, priorPermission: null });
  });

  it("I-D: a company vault's shares can't be changed through the personal-collection routes", async () => {
    const page = "Use the company page to share company vaults.";
    expect(await failure(CollectionService.share(41, 1, "lu@acme.com"))).toMatchObject({ status: 400, message: page });
    expect(await failure(CollectionService.revoke(41, 1, 3))).toMatchObject({ status: 400, message: page });
    expect(await failure(CollectionService.shareWithMany(41, 1, ["lu@acme.com"]))).toMatchObject({ status: 400, message: page });
    expect(db.shares.find((row) => row.sharedWithUserId === 3)).toBeTruthy();
  });

  it("I-E: a member who manages a vault sees who has it", async () => {
    db.shares.push({ id: 22, collectionId: 41, sharedByUserId: 3, sharedWithUserId: 4, permission: "view", manages: false, source: "direct", expiresAt: null });
    const rows: any[] = await CollectionService.listForCompany(7, 3);
    expect(rows.find((row) => row.id === 41).shares.map((row: any) => row.userId).sort()).toEqual([3, 4]);
  });

  it("the only manager leaving the company isn't blocked; the vault then shows No manager", async () => {
    db.members.find((row) => row.userId === 3)!.status = "suspended";
    const rows: any[] = await CollectionService.listForCompany(7, 1);
    expect(rows.find((row) => row.id === 41).noManager).toBe(true);
  });
});
