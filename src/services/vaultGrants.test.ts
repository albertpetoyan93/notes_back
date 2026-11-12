import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import CollectionShare from "@src/models/CollectionShare";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import User from "@src/models/User";
import AuditService from "@src/services/AuditService";
import CollectionService from "@src/services/CollectionService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import E2EItemService from "@src/services/E2EItemService";
import GroupService from "@src/services/GroupService";
import { table } from "@src/services/recoveryTestDb";

let db: Record<string, any[]>;

// Acme (7): Olga owner (1) with a legacy grant on vault 40; Ade admin (2) with no grant;
// Mo member (3) who manages vault 41; vault 42 has nobody but Olga's legacy grant.
beforeEach(() => {
  vi.spyOn(CompanyPolicyService, "forUser").mockResolvedValue({ blocked: new Set<number>() } as never);
  vi.spyOn(GroupService, "forUser").mockResolvedValue(new Map() as never);
  vi.spyOn(GroupService, "byCollection").mockResolvedValue(new Map() as never);
  vi.spyOn(GroupService, "sharesOf").mockResolvedValue(new Map() as never);
  vi.spyOn(CollectionService as any, "noteCounts").mockResolvedValue(new Map([[40, 4], [41, 2]]));
  db = {
    users: table(User, [
      { id: 1, email: "olga@acme.com", e2eEnabled: true, publicKey: "P1" },
      { id: 2, email: "ade@acme.com", e2eEnabled: true, publicKey: "P2" },
      { id: 3, email: "mo@acme.com", e2eEnabled: true, publicKey: "P3" },
    ]),
    companies: table(Company, [{ id: 7, name: "Acme", status: "active" }]),
    members: table(CompanyMember, [
      { id: 11, companyId: 7, userId: 1, role: "owner", status: "active" },
      { id: 12, companyId: 7, userId: 2, role: "admin", status: "active" },
      { id: 13, companyId: 7, userId: 3, role: "member", status: "active" },
    ]),
    collections: table(Collection, [
      { id: 40, companyId: 7, userId: 1, name: "Ops", companyShare: null, e2eKeyVersion: 1 },
      { id: 41, companyId: 7, userId: 1, name: "Dev", companyShare: null, e2eKeyVersion: 1 },
    ]),
    shares: table(CollectionShare, [
      { id: 1, collectionId: 40, sharedByUserId: 1, sharedWithUserId: 1, permission: "edit", manages: true, source: "admin_legacy", expiresAt: null },
      { id: 2, collectionId: 41, sharedByUserId: 1, sharedWithUserId: 3, permission: "edit", manages: true, source: "direct", expiresAt: null },
    ]),
    keys: table(CollectionKey, []),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("company vaults open by grant, not by role", () => {
  it("an admin with no grant can't open a vault; a legacy grant opens it as an editing manager", async () => {
    expect(await CollectionService.getAccess(40, 2)).toBeNull();
    expect(await CollectionService.getAccess(40, 1)).toMatchObject({ permission: "edit", manages: true });
  });

  it("openCompanyCollections leaves out vaults the admin has no grant on (search, health, export)", async () => {
    const open = await CollectionService.openCompanyCollections(2);
    expect([...open.keys()]).toEqual([]);
    expect(await CollectionService.openCompanyCollections(1)).toEqual(new Map([[40, "edit"]]));
  });

  it("vault managers hand keys on: a managing member yes, an admin without a grant no", async () => {
    const forMo = await (E2EItemService as any).managedCollections(3);
    expect(forMo.map((row: any) => row.id)).toEqual([41]);
    const forAde = await (E2EItemService as any).managedCollections(2);
    expect(forAde.map((row: any) => row.id)).toEqual([]);
  });

  it("people with access: an admin counts only through a grant (no key rotation for legacy holders)", async () => {
    const people = await E2EItemService.membersOf([40]);
    expect((people.get(40) || []).map((row: any) => row.userId).sort()).toEqual([1]);
  });

  it("offboarding an admin lists only vaults they could open through grants", async () => {
    const vaults = await AuditService.openableCollections(7, 1, 2);
    expect(vaults).toEqual([]);
    expect((await AuditService.openableCollections(7, 1, 1))?.map((row) => row.id)).toEqual([40]);
  });

  it("the Collections tab shows an admin every vault, with no access where there's no grant", async () => {
    const rows: any[] = await CollectionService.listForCompany(7, 2);
    expect(rows.map((row) => [row.id, row.permission, row.manages, row.noteCount]).sort()).toEqual([
      [40, null, false, null],
      [41, null, false, null],
    ]);
    const ops = rows.find((row) => row.id === 40);
    expect(ops.shares).toEqual([expect.objectContaining({ userId: 1, manages: true, source: "admin_legacy" })]);
    expect(ops.noManager).toBe(false);
  });

  it("whoever creates a company vault manages it (else nobody could open it)", async () => {
    const made = await CollectionService.createForCompany(7, 2, "Finance");
    expect(db.shares.find((row) => row.collectionId === made.id)).toMatchObject({
      sharedWithUserId: 2,
      permission: "edit",
      manages: true,
      source: "direct",
    });
  });

  it("a member only sees vaults they reach, and knows when they manage one", async () => {
    const rows: any[] = await CollectionService.listForCompany(7, 3);
    expect(rows.map((row) => [row.id, row.permission, row.manages, row.noteCount])).toEqual([[41, "edit", true, 2]]);
  });
});
