import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Op } from "sequelize";
import sequelize from "@src/configs/DB/sequelize";
import Collection from "@src/models/Collection";
import CollectionKey from "@src/models/CollectionKey";
import CompanyMember from "@src/models/CompanyMember";
import CompanyOffboarding from "@src/models/CompanyOffboarding";
import OffboardingTask from "@src/models/OffboardingTask";
import AuditService from "@src/services/AuditService";
import OffboardingService from "@src/services/OffboardingService";

const TX = { id: "tx" };
const zero = { pending: 0, in_progress: 0, failed: 0, done: 0, not_required: 0 };

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

let offboarding: any;

beforeEach(() => {
  offboarding = { id: 40, companyId: 7, userId: 3, memberEmail: "sam@example.com", status: "in_progress", completedAt: null };
  vi.spyOn(sequelize, "transaction").mockImplementation((async (fn: any) => fn(TX)) as never);
  // The caller is an owner of company 7.
  vi.spyOn(CompanyMember, "findOne").mockResolvedValue({ id: 1 } as never);
  vi.spyOn(CompanyOffboarding, "findOne").mockResolvedValue(offboarding as never);
  vi.spyOn(CompanyOffboarding, "findAll").mockResolvedValue([offboarding] as never);
  vi.spyOn(Collection, "findAll").mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
  vi.spyOn(CollectionKey, "count").mockResolvedValue(0 as never);
  vi.spyOn(OffboardingTask, "findAll").mockResolvedValue([{ offboardingId: 40, status: "done", total: "3" }] as never);
  vi.spyOn(OffboardingTask, "update").mockResolvedValue([2] as never);
  vi.spyOn(OffboardingTask, "findAndCountAll").mockResolvedValue({ rows: [], count: 250 } as never);
  vi.spyOn(CompanyOffboarding, "update").mockResolvedValue([1] as never);
  vi.spyOn(CompanyMember, "update").mockResolvedValue([1] as never);
  vi.spyOn(AuditService, "record").mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isComplete", () => {
  it("needs no open or failed task and no held key", () => {
    expect(OffboardingService.isComplete({ ...zero, done: 3, not_required: 1 }, true)).toBe(true);
    expect(OffboardingService.isComplete({ ...zero, done: 3, failed: 1 }, true)).toBe(false);
    expect(OffboardingService.isComplete({ ...zero, pending: 1 }, true)).toBe(false);
    expect(OffboardingService.isComplete({ ...zero, in_progress: 1 }, true)).toBe(false);
    expect(OffboardingService.isComplete({ ...zero, done: 3 }, false)).toBe(false);
  });
});

describe("keysRotated", () => {
  it("is true only when the person holds no key of any company collection", async () => {
    expect(await OffboardingService.keysRotated(7, 3)).toBe(true);
    expect(CollectionKey.count).toHaveBeenCalledWith({ where: { userId: 3, collectionId: { [Op.in]: [1, 2] } } });
    vi.mocked(CollectionKey.count).mockResolvedValue(1 as never);
    expect(await OffboardingService.keysRotated(7, 3)).toBe(false);
  });
});

describe("OffboardingService.updateTasks", () => {
  it("rejects a reference over 200 characters", async () => {
    const err = await failure(
      OffboardingService.updateTasks(7, 1, 40, { taskIds: [1], status: "done", reference: "x".repeat(201) })
    );
    expect(err.status).toBe(400);
    expect(OffboardingTask.update).not.toHaveBeenCalled();
  });

  it("rejects a note over 500 characters, an unknown status and 101 ids", async () => {
    expect((await failure(OffboardingService.updateTasks(7, 1, 40, { taskIds: [1], status: "done", note: "x".repeat(501) }))).status).toBe(400);
    expect((await failure(OffboardingService.updateTasks(7, 1, 40, { taskIds: [1], status: "finished" }))).status).toBe(400);
    const ids = Array.from({ length: 101 }, (_, index) => index + 1);
    expect((await failure(OffboardingService.updateTasks(7, 1, 40, { taskIds: ids, status: "done" }))).status).toBe(400);
    expect((await failure(OffboardingService.updateTasks(7, 1, 40, { taskIds: [], status: "done" }))).status).toBe(400);
    expect(OffboardingTask.update).not.toHaveBeenCalled();
  });

  it("only touches tasks of this offboarding, records the manager, and logs one row without item titles", async () => {
    vi.mocked(OffboardingTask.findAll).mockResolvedValue([{ offboardingId: 40, status: "failed", total: "2" }] as never);
    const result = await OffboardingService.updateTasks(7, 1, 40, { taskIds: [1, 2, 3], status: "failed", note: "no access" });

    expect(OffboardingTask.update).toHaveBeenCalledWith(
      { status: "failed", actorId: 1, note: "no access" },
      { where: { id: { [Op.in]: [1, 2, 3] }, offboardingId: 40 } }
    );
    expect(result.updated).toBe(2);
    expect(AuditService.record).toHaveBeenCalledTimes(1);
    expect(AuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "offboarding_task_updated",
        companyId: 7,
        details: { offboardingId: 40, count: 2, status: "failed" },
      })
    );
    // A failed task keeps it open.
    expect(CompanyOffboarding.update).not.toHaveBeenCalled();
  });

  it("is not found for an offboarding of another company", async () => {
    vi.mocked(CompanyOffboarding.findOne).mockResolvedValue(null as never);
    const err = await failure(OffboardingService.updateTasks(7, 1, 99, { taskIds: [1], status: "done" }));
    expect(err.status).toBe(404);
    expect(CompanyOffboarding.findOne).toHaveBeenCalledWith({ where: { id: 99, companyId: 7 } });
  });

  it("is refused for someone who is not an owner or admin", async () => {
    vi.mocked(CompanyMember.findOne).mockResolvedValue(null as never);
    const err = await failure(OffboardingService.updateTasks(7, 5, 40, { taskIds: [1], status: "done" }));
    expect(err.status).toBe(403);
  });

  it("completes the offboarding once everything is done and keys are gone", async () => {
    await OffboardingService.updateTasks(7, 1, 40, { taskIds: [1], status: "done" });

    expect(CompanyOffboarding.update).toHaveBeenCalledWith(
      { status: "complete", completedAt: expect.any(Date) },
      { where: { id: 40, status: "in_progress" }, transaction: TX }
    );
    expect(CompanyMember.update).toHaveBeenCalledWith(
      { status: "removed", removedAt: expect.any(Date) },
      { where: { companyId: 7, userId: 3, status: "suspended" }, transaction: TX }
    );
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: "offboarding_completed", companyId: 7 }));
  });

  it("does not complete while a company collection key is still held", async () => {
    vi.mocked(CollectionKey.count).mockResolvedValue(1 as never);
    await OffboardingService.updateTasks(7, 1, 40, { taskIds: [1], status: "done" });
    expect(CompanyOffboarding.update).not.toHaveBeenCalled();
  });

  it("completes exactly once when another check won the race", async () => {
    vi.mocked(CompanyOffboarding.update).mockResolvedValue([0] as never);
    await OffboardingService.updateTasks(7, 1, 40, { taskIds: [1], status: "done" });
    expect(CompanyMember.update).not.toHaveBeenCalled();
    expect(AuditService.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: "offboarding_completed" }));
  });
});

describe("OffboardingService.completeOpenFor", () => {
  it("completes open offboardings that are now done", async () => {
    await OffboardingService.completeOpenFor(7, 1);
    expect(CompanyOffboarding.findAll).toHaveBeenCalledWith({ where: { companyId: 7, status: "in_progress" } });
    expect(CompanyMember.update).toHaveBeenCalledTimes(1);
  });
});

describe("OffboardingService.completeOpenFor failures", () => {
  it("keeps going when one offboarding fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const second = { ...offboarding, id: 41, userId: 4 };
    vi.mocked(CompanyOffboarding.findAll).mockResolvedValue([offboarding, second] as never);
    vi.mocked(CollectionKey.count).mockRejectedValueOnce(new Error("db down") as never);

    await OffboardingService.completeOpenFor(7, 1);

    expect(CompanyMember.update).toHaveBeenCalledTimes(1);
    expect(CompanyMember.update).toHaveBeenCalledWith(expect.anything(), { where: expect.objectContaining({ userId: 4 }), transaction: TX });
  });
});

describe("OffboardingService.detail", () => {
  it("lists 100 per page with an offset from the page", async () => {
    const result = await OffboardingService.detail(7, 1, 40, "pending", 3);

    expect(OffboardingTask.findAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { offboardingId: 40, status: "pending" }, limit: 100, offset: 200 })
    );
    expect(result.total).toBe(250);
  });

  it("rejects an unknown status filter", async () => {
    expect((await failure(OffboardingService.detail(7, 1, 40, "nope"))).status).toBe(400);
  });
});

describe("OffboardingService.list", () => {
  it("returns counts for every status and whether keys are rotated", async () => {
    const rows = await OffboardingService.list(7, 1);
    expect(rows).toEqual([
      expect.objectContaining({ id: 40, userId: 3, status: "in_progress", counts: { ...zero, done: 3 }, keysRotated: true }),
    ]);
  });
});
