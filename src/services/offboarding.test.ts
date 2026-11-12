import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Op, UniqueConstraintError } from "sequelize";
import sequelize from "@src/configs/DB/sequelize";
import AuditEvent from "@src/models/AuditEvent";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import CollectionNote from "@src/models/CollectionNote";
import CollectionShare from "@src/models/CollectionShare";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import CompanyOffboarding from "@src/models/CompanyOffboarding";
import { RecoveryCustodian } from "@src/models/CompanyRecovery";
import Note from "@src/models/Note";
import NoteShare from "@src/models/NoteShare";
import OffboardingTask from "@src/models/OffboardingTask";
import AuditService, { AUDIT_ACTIONS, USER_ACTIVITY_ACTIONS } from "@src/services/AuditService";
import CollectionService from "@src/services/CollectionService";
import CompanyService from "@src/services/CompanyService";
import GroupService from "@src/services/GroupService";
import OffboardingService from "@src/services/OffboardingService";
import StripeService from "@src/services/StripeService";
import User from "@src/models/User";

// Manager 1 removes member row 20 (user 3) from company 7.
const TX = { id: "tx" };
let member: any;

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

beforeEach(() => {
  // Removing someone also ends any vault-recovery custody they had.
  vi.spyOn(RecoveryCustodian, "destroy").mockResolvedValue(0 as never);
  member = { id: 20, companyId: 7, userId: 3, email: "sam@example.com", role: "member", status: "active" };
  member.update = vi.fn(async (fields: Record<string, unknown>) => Object.assign(member, fields));
  member.destroy = vi.fn();
  vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn(TX)) as never);
  vi.spyOn(CompanyMember, "findOne").mockResolvedValue(member as never);
  vi.spyOn(AuditService, "openableCollections").mockResolvedValue([
    { id: 1, name: "Team", permission: "edit" },
    { id: 2, name: "Ops", permission: "view" },
  ] as never);
  vi.spyOn(CollectionService, "noteIdsForCollections").mockResolvedValue([10, 11, 12] as never);
  // 13 is a work item shared to them directly; 99 is someone's personal item.
  vi.spyOn(NoteShare, "findAll").mockResolvedValue([{ noteId: 13 }, { noteId: 99 }] as never);
  vi.spyOn(Note, "findAll").mockResolvedValue([
    { id: 10, e2e: true, companyId: 7 },
    { id: 11, e2e: false, companyId: 7 },
    { id: 12, e2e: true, companyId: 7 },
    { id: 13, e2e: true, companyId: 7 },
    { id: 99, e2e: true, companyId: null },
  ] as never);
  vi.spyOn(CollectionService, "collectionsByNoteId").mockResolvedValue(
    new Map([[99, [{ id: 50, name: "Mine", companyId: null }]]]) as never
  );
  vi.spyOn(Note, "update").mockResolvedValue([3] as never);
  vi.spyOn(CompanyOffboarding, "create").mockResolvedValue({ id: 40 } as never);
  vi.spyOn(CompanyOffboarding, "findOne").mockResolvedValue({ id: 40 } as never);
  vi.spyOn(OffboardingTask, "bulkCreate").mockResolvedValue([] as never);
  vi.spyOn(GroupService, "leaveCompany").mockResolvedValue(undefined as never);
  vi.spyOn(StripeService, "syncSeatsLater").mockReturnValue(undefined as never);
  vi.spyOn(AuditService, "record").mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OffboardingService.start", () => {
  it("suspends the member, opens one offboarding with a task per work item, and changes no item", async () => {
    expect(await OffboardingService.start(7, 1, 20)).toEqual({ offboardingId: 40, created: true });

    expect(member.update).toHaveBeenCalledWith({ status: "suspended" }, { transaction: TX });
    expect(member.destroy).not.toHaveBeenCalled();
    expect(GroupService.leaveCompany).toHaveBeenCalledWith(7, 3, { transaction: TX });
    expect(CollectionService.noteIdsForCollections).toHaveBeenCalledWith([1, 2], { paranoid: false });
    // Trashed items they could open count too.
    expect(Note.findAll).toHaveBeenCalledWith(expect.objectContaining({ paranoid: false }));

    expect(CompanyOffboarding.create).toHaveBeenCalledTimes(1);
    expect(CompanyOffboarding.create).toHaveBeenCalledWith(
      { companyId: 7, userId: 3, memberEmail: "sam@example.com", startedBy: 1, status: "in_progress" },
      { transaction: TX }
    );
    const tasks = vi.mocked(OffboardingTask.bulkCreate).mock.calls.flatMap(([rows]) => rows as any[]);
    expect(tasks).toEqual(
      [10, 11, 12, 13].map((noteId) => ({ offboardingId: 40, kind: "rotate_credential", noteId, status: "pending" }))
    );

    // Item keys aren't replaced: the tasks (change it at the source) are the protection.
    expect(Note.update).not.toHaveBeenCalled();

    expect(AuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "offboarding_started", actorId: 1, companyId: 7, targetUserId: 3 })
    );
    expect(StripeService.syncSeatsLater).toHaveBeenCalledWith(7);
  });

  it("creates tasks in chunks of 500", async () => {
    const ids = Array.from({ length: 1200 }, (_, index) => index + 1000);
    vi.mocked(CollectionService.noteIdsForCollections).mockResolvedValue(ids as never);
    vi.mocked(NoteShare.findAll).mockResolvedValue([] as never);
    vi.mocked(Note.findAll).mockResolvedValue(ids.map((id) => ({ id, e2e: false, companyId: 7 })) as never);

    await OffboardingService.start(7, 1, 20);

    const sizes = vi.mocked(OffboardingTask.bulkCreate).mock.calls.map(([rows]) => (rows as any[]).length);
    expect(sizes).toEqual([500, 500, 200]);
    expect(Note.update).not.toHaveBeenCalled();
  });

  it("returns the open offboarding when another manager already started one, and creates no tasks", async () => {
    vi.mocked(CompanyOffboarding.create).mockRejectedValue(new UniqueConstraintError({}) as never);

    expect(await OffboardingService.start(7, 1, 20)).toEqual({ offboardingId: 40, created: false });

    expect(CompanyOffboarding.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 7, userId: 3, status: "in_progress" } })
    );
    expect(OffboardingTask.bulkCreate).not.toHaveBeenCalled();
    expect(Note.update).not.toHaveBeenCalled();
    expect(AuditService.record).not.toHaveBeenCalled();
    expect(StripeService.syncSeatsLater).not.toHaveBeenCalled();
  });

  it("returns the open offboarding for a suspended member without recomputing anything", async () => {
    member.status = "suspended";
    expect(await OffboardingService.start(7, 1, 20)).toEqual({ offboardingId: 40, created: false });
    expect(AuditService.openableCollections).not.toHaveBeenCalled();
    expect(member.update).not.toHaveBeenCalled();
    expect(CompanyOffboarding.create).not.toHaveBeenCalled();
    expect(StripeService.syncSeatsLater).not.toHaveBeenCalled();
  });

  it("counts a direct share on an unassigned item in a company collection, not another company's item", async () => {
    vi.mocked(CollectionService.noteIdsForCollections).mockResolvedValue([] as never);
    vi.mocked(NoteShare.findAll).mockResolvedValue([{ noteId: 14 }, { noteId: 15 }] as never);
    vi.mocked(Note.findAll).mockResolvedValue([
      { id: 14, e2e: false, companyId: null },
      { id: 15, e2e: false, companyId: 8 },
    ] as never);
    vi.mocked(CollectionService.collectionsByNoteId).mockResolvedValue(
      new Map([
        [14, [{ id: 1, name: "Team", companyId: 7 }]],
        [15, [{ id: 60, name: "Other", companyId: 8 }]],
      ]) as never
    );

    await OffboardingService.start(7, 1, 20);

    const tasks = vi.mocked(OffboardingTask.bulkCreate).mock.calls.flatMap(([rows]) => rows as any[]);
    expect(tasks.map((task) => task.noteId)).toEqual([14]);
  });

  it("an expired collection share gives no collection, no tasks", async () => {
    vi.mocked(AuditService.openableCollections).mockRestore();
    expiredShareWorld();
    vi.mocked(CollectionService.noteIdsForCollections).mockImplementation((async (ids: number[]) =>
      (ids.includes(1) ? [10] : [])) as never);
    vi.mocked(NoteShare.findAll).mockResolvedValue([] as never);

    await OffboardingService.start(7, 1, 20);

    expect(CollectionService.noteIdsForCollections).toHaveBeenCalledWith([], { paranoid: false });
    expect(OffboardingTask.bulkCreate).not.toHaveBeenCalled();
    expect(Note.update).not.toHaveBeenCalled();
  });

  it("refuses a caller who isn't an owner or admin", async () => {
    vi.mocked(AuditService.openableCollections).mockResolvedValue(null as never);
    expect((await failure(OffboardingService.start(7, 1, 20))).status).toBe(403);
    expect(CompanyOffboarding.create).not.toHaveBeenCalled();
  });
});

// Manager 1, member 3 with only an expired edit share on collection 1.
function expiredShareWorld() {
  vi.mocked(CompanyMember.findOne).mockImplementation((async (options: any) => {
    if (options.where.id !== undefined) return member;
    if (options.where.userId === 1) return { companyId: 7, userId: 1, role: "owner", status: "active" };
    return { role: "member" };
  }) as never);
  vi.spyOn(Collection, "findAll").mockResolvedValue([{ id: 1, name: "Team", encName: null, companyShare: null }] as never);
  const shares = [{ collectionId: 1, permission: "edit", expiresAt: new Date(Date.now() - 1000) }];
  // Honours the expiry filter the way the database would.
  vi.spyOn(CollectionShare, "findAll").mockImplementation((async (options: any) =>
    options.where[Op.or] ? shares.filter((share) => !share.expiresAt || share.expiresAt > new Date()) : shares) as never);
  vi.spyOn(GroupService, "forUser").mockResolvedValue(new Map() as never);
}

describe("AuditService.memberAccess", () => {
  it("doesn't list a collection whose share has expired", async () => {
    vi.mocked(AuditService.openableCollections).mockRestore();
    expiredShareWorld();
    vi.spyOn(AuditEvent, "findAll").mockResolvedValue([] as never);
    expect(await AuditService.memberAccess(7, 1, 3)).toEqual({ collections: [], secretsAccessed: [] });
  });
});

describe("CollectionService.noteIdsForCollections", () => {
  it("can include trashed items", async () => {
    vi.mocked(CollectionService.noteIdsForCollections).mockRestore();
    vi.spyOn(CollectionNote, "findAll").mockResolvedValue([] as never);
    vi.mocked(Note.findAll).mockResolvedValue([{ id: 10, collectionId: 1 }] as never);
    expect(await CollectionService.noteIdsForCollections([1], { paranoid: false })).toEqual([10]);
    expect(Note.findAll).toHaveBeenCalledWith(expect.objectContaining({ paranoid: false }));
  });
});

describe("CompanyService.members", () => {
  it("lists suspended members, so managers see who is being offboarded", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue({ id: 1, email: "boss@example.com" } as never);
    // Who has end-to-end encryption on (members() reports it).
    vi.spyOn(User, "findAll").mockResolvedValue([{ id: 3, e2eEnabled: true }] as never);
    vi.spyOn(Company, "findByPk").mockResolvedValue({ id: 7, status: "active" } as never);
    vi.mocked(CompanyMember.findOne).mockResolvedValue({ role: "owner" } as never);
    const rows = [
      { id: 20, userId: 3, email: "sam@example.com", role: "member", status: "suspended", expiresAt: null },
      { id: 21, userId: 4, email: "ann@example.com", role: "member", status: "active", expiresAt: null },
    ];
    // Honours the status filter the way the database would.
    vi.spyOn(CompanyMember, "findAll").mockImplementation((async (options: any) =>
      rows.filter((row) => (options.where[Op.or] as any[]).some((cond) => cond.status === row.status))) as never);
    const list = await CompanyService.members(7, 1);
    expect(list.map((row) => row.status)).toEqual(["suspended", "active"]);
  });
});

describe("CompanyService.removeMember", () => {
  let actor: any;

  beforeEach(() => {
    actor = { companyId: 7, userId: 1, role: "owner", status: "active" };
    vi.spyOn(Company, "findByPk").mockResolvedValue({ id: 7, status: "active" } as never);
    vi.mocked(CompanyMember.findOne).mockImplementation((async (options: any) =>
      options.where.id === undefined ? actor : member) as never);
    vi.spyOn(OffboardingService, "start").mockResolvedValue({ offboardingId: 40, created: true } as never);
  });

  it("starts an offboarding for an active member instead of deleting them", async () => {
    expect(await CompanyService.removeMember(7, 1, 20)).toEqual({ ok: true, offboardingId: 40, created: true });
    expect(OffboardingService.start).toHaveBeenCalledWith(7, 1, 20);
    expect(member.destroy).not.toHaveBeenCalled();
  });

  it("returns the open offboarding for a member already suspended", async () => {
    vi.mocked(OffboardingService.start).mockRestore();
    member.status = "suspended";
    expect(await CompanyService.removeMember(7, 1, 20)).toEqual({ ok: true, offboardingId: 40, created: false });
    expect(CompanyOffboarding.create).not.toHaveBeenCalled();
    expect(member.update).not.toHaveBeenCalled();
    expect(member.destroy).not.toHaveBeenCalled();
  });

  it("still deletes an invite", async () => {
    member.status = "invited";
    expect(await CompanyService.removeMember(7, 1, 20)).toEqual({ ok: true });
    expect(member.destroy).toHaveBeenCalled();
    expect(OffboardingService.start).not.toHaveBeenCalled();
  });

  it("lets only the owner remove an admin", async () => {
    actor.role = "admin";
    member.role = "admin";
    expect((await failure(CompanyService.removeMember(7, 1, 20))).status).toBe(403);
    expect(OffboardingService.start).not.toHaveBeenCalled();
  });

  it("never removes the owner", async () => {
    member.role = "owner";
    expect((await failure(CompanyService.removeMember(7, 1, 20))).status).toBe(400);
    expect(OffboardingService.start).not.toHaveBeenCalled();
  });
});

describe("CompanyService.invite", () => {
  it("refuses to re-invite someone who is being offboarded", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue({ id: 1, email: "boss@example.com" } as never);
    vi.spyOn(User, "findOne").mockResolvedValue({ id: 3, email: "sam@example.com" } as never);
    vi.spyOn(Company, "findByPk").mockResolvedValue({ id: 7, status: "active" } as never);
    member.status = "suspended";
    vi.mocked(CompanyMember.findOne).mockImplementation((async (options: any) =>
      options.where.email ? member : { role: "owner" }) as never);
    const err = await failure(CompanyService.invite(7, 1, "sam@example.com", "member"));
    expect(err.status).toBe(409);
    expect(err.message).toBe("This person is being offboarded. Finish their offboarding first.");
    expect(member.update).not.toHaveBeenCalled();
  });
});

describe("OffboardingService.start races and completion", () => {
  it("refuses when the unique index fires but the member is no longer suspended", async () => {
    vi.mocked(CompanyOffboarding.create).mockRejectedValue(new UniqueConstraintError({}) as never);
    // The re-read sees them active again (re-invited and accepted meanwhile).
    vi.mocked(CompanyMember.findOne)
      .mockResolvedValueOnce(member as never)
      .mockResolvedValueOnce({ ...member, status: "active" } as never);
    const err = await failure(OffboardingService.start(7, 1, 20));
    expect(err.status).toBe(409);
  });

  it("completes a zero-task offboarding at once when the person holds no company key", async () => {
    vi.mocked(CollectionService.noteIdsForCollections).mockResolvedValue([] as never);
    vi.mocked(NoteShare.findAll).mockResolvedValue([] as never);
    vi.mocked(CompanyOffboarding.create).mockResolvedValue({ id: 40, companyId: 7, userId: 3, status: "in_progress" } as never);
    vi.spyOn(OffboardingTask, "findAll").mockResolvedValue([] as never);
    vi.spyOn(Collection, "findAll").mockResolvedValue([{ id: 1 }] as never);
    vi.spyOn(CollectionKey, "count").mockResolvedValue(0 as never);
    vi.spyOn(CompanyOffboarding, "update").mockResolvedValue([1] as never);
    vi.spyOn(CompanyMember, "update").mockResolvedValue([1] as never);

    expect(await OffboardingService.start(7, 1, 20)).toEqual({ offboardingId: 40, created: true });

    expect(CompanyOffboarding.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "complete" }),
      expect.objectContaining({ where: { id: 40, status: "in_progress" } })
    );
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: "offboarding_completed" }));
  });

  it("completes an in-progress offboarding when its list or detail is read", async () => {
    const open = { id: 40, companyId: 7, userId: 3, status: "in_progress", startedAt: new Date() };
    vi.mocked(CompanyMember.findOne).mockResolvedValue({ id: 1 } as never);
    vi.spyOn(CompanyOffboarding, "findAll").mockResolvedValue([open] as never);
    vi.mocked(CompanyOffboarding.findOne).mockResolvedValue(open as never);
    vi.spyOn(OffboardingTask, "findAll").mockResolvedValue([] as never);
    vi.spyOn(OffboardingTask, "findAndCountAll").mockResolvedValue({ rows: [], count: 0 } as never);
    vi.spyOn(Collection, "findAll").mockResolvedValue([] as never);
    vi.spyOn(CompanyOffboarding, "update").mockResolvedValue([1] as never);
    vi.spyOn(CompanyMember, "update").mockResolvedValue([1] as never);

    await OffboardingService.list(7, 1);
    expect(CompanyOffboarding.update).toHaveBeenCalledTimes(1);

    vi.mocked(CompanyOffboarding.update).mockClear();
    await OffboardingService.detail(7, 1, 40);
    expect(CompanyOffboarding.update).toHaveBeenCalledTimes(1);
  });

  it("gives a legacy item without a company a task too", async () => {
    vi.mocked(Note.findAll).mockResolvedValue([
      { id: 10, e2e: true, companyId: 7 },
      { id: 12, e2e: true, companyId: null },
    ] as never);
    vi.mocked(CollectionService.noteIdsForCollections).mockResolvedValue([10, 12] as never);
    vi.mocked(NoteShare.findAll).mockResolvedValue([] as never);

    await OffboardingService.start(7, 1, 20);

    const tasks = vi.mocked(OffboardingTask.bulkCreate).mock.calls.flatMap(([rows]) => rows as any[]);
    expect(tasks.map((task) => task.noteId)).toEqual([10, 12]);
  });
});

describe("offboarding audit actions", () => {
  it("show in the company log but never in staff-visible activity", () => {
    for (const action of ["offboarding_started", "offboarding_completed", "offboarding_task_updated"] as const) {
      expect(AUDIT_ACTIONS).toContain(action);
      expect(USER_ACTIVITY_ACTIONS).not.toContain(action);
    }
  });
});
