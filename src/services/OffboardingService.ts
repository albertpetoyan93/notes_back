import { Op, UniqueConstraintError } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Collection from "../models/Collection";
import CollectionKey from "../models/CollectionKey";
import CompanyMember from "../models/CompanyMember";
import CompanyOffboarding from "../models/CompanyOffboarding";
import Note from "../models/Note";
import NoteShare from "../models/NoteShare";
import OffboardingTask, { TaskStatus } from "../models/OffboardingTask";
import AuditService from "./AuditService";
import CollectionService from "./CollectionService";
import GroupService from "./GroupService";
import StripeService from "./StripeService";

// Big companies: thousands of tasks go in a few inserts, not one huge one.
const CHUNK = 500;

const PAGE = 100;
// On a task the app marked done because the item's password was changed in 2keevo.
const AUTO_DONE_NOTE = "Password changed in 2keevo";
const STATUSES: TaskStatus[] = ["pending", "in_progress", "done", "not_required", "failed"];

export type TaskCounts = Record<TaskStatus, number>;

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function chunks<T>(rows: T[]) {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) result.push(rows.slice(i, i + CHUNK));
  return result;
}

class OffboardingService {
  /**
   * Someone leaves a company: their access stops now (suspended), and the
   * company gets a to-do list of credentials to change, one per work item
   * they could open. Their collection key copies stay, so the key-task flow
   * sees them as stale holders and rotates those collections.
   */
  async start(companyId: number, managerId: number, memberId: number): Promise<{ offboardingId: number; created: boolean }> {
    const member = await CompanyMember.findOne({ where: { id: memberId, companyId } });
    if (!member?.userId || (member.status !== "active" && member.status !== "suspended")) {
      fail(400, "That person cannot be removed");
    }
    const userId = member.userId;
    // Already being offboarded (a second removal): hand back that one.
    if (member.status === "suspended") {
      const open = await this.openFor(companyId, userId);
      if (open) return { offboardingId: open.id, created: false };
    }

    // Read before their groups are left, while group access still shows.
    const collections = await AuditService.openableCollections(companyId, managerId, userId);
    if (!collections) fail(403, "You cannot remove people from this company");
    // Read outside the transaction: an item added meanwhile gets no task.
    const items = await this.workItems(companyId, userId, collections.map((collection) => collection.id));

    let offboarding: CompanyOffboarding;
    try {
      offboarding = await sequelize.transaction(async (transaction) => {
        await member.update({ status: "suspended" }, { transaction });
        await GroupService.leaveCompany(companyId, userId, { transaction });
        // The unique index allows one open offboarding per person.
        const created = await CompanyOffboarding.create(
          { companyId, userId, memberEmail: member.email, startedBy: managerId, status: "in_progress" },
          { transaction }
        );
        for (const part of chunks(items)) {
          await OffboardingTask.bulkCreate(
            part.map((item) => ({
              offboardingId: created.id,
              kind: "rotate_credential" as const,
              noteId: item.id,
              status: "pending" as const,
            })),
            { transaction }
          );
        }
        return created;
      });
    } catch (error) {
      // Another manager removed them at the same moment: theirs is the one, if they're still suspended.
      if (error instanceof UniqueConstraintError) {
        const now = await CompanyMember.findOne({ where: { id: memberId, companyId }, attributes: ["id", "status"] });
        const open = now?.status === "suspended" ? await this.openFor(companyId, userId) : null;
        if (open) return { offboardingId: open.id, created: false };
        fail(409, "This person's membership changed meanwhile. Try again.");
      }
      throw error;
    }
    const offboardingId = offboarding.id;

    await AuditService.record({
      actorId: managerId,
      action: "offboarding_started",
      companyId,
      targetUserId: userId,
      details: { email: member.email, tasks: items.length },
    });
    // A suspended member's seat stops being billed at the next renewal.
    StripeService.syncSeatsLater(companyId);
    // No tasks: done at once (keys they hold are replaced in the background).
    await this.completeQuietly(offboarding, managerId);
    return { offboardingId, created: true };
  }

  private async requireManager(companyId: number, userId: number) {
    const member = await CompanyMember.findOne({
      where: { companyId, userId, status: "active", role: { [Op.in]: ["owner", "admin"] } },
      attributes: ["id"],
    });
    if (!member) fail(403, "Only owners and admins can see this");
  }

  // An id from another company is simply not found.
  private async requireOffboarding(companyId: number, offboardingId: number) {
    const offboarding = await CompanyOffboarding.findOne({ where: { id: offboardingId, companyId } });
    if (!offboarding) fail(404, "Offboarding not found");
    return offboarding;
  }

  /**
   * Done when no task is open or failed. Their access stopped at removal; the
   * collection keys they still hold are replaced in the background by an
   * owner's or admin's browser (the "rotate" key task, which doesn't depend on
   * the offboarding) and only reported (keysRotated), so the wait for a browser
   * never holds the offboarding up.
   */
  isComplete(counts: TaskCounts): boolean {
    return counts.pending === 0 && counts.in_progress === 0 && counts.failed === 0;
  }

  /** No company collection key left to replace: none held, or they're a member again (it's theirs). */
  async keysRotated(companyId: number, userId: number): Promise<boolean> {
    const member = await CompanyMember.findOne({ where: { companyId, userId }, attributes: ["id", "status"] });
    if (member?.status === "active") return true;
    const collections = await Collection.findAll({ where: { companyId }, attributes: ["id"] });
    if (!collections.length) return true;
    const held = await CollectionKey.count({
      where: { userId, collectionId: { [Op.in]: collections.map((collection) => collection.id) } },
    });
    return held === 0;
  }

  private async countsFor(offboardingIds: number[]) {
    const result = new Map<number, TaskCounts>();
    for (const id of offboardingIds) {
      result.set(id, { pending: 0, in_progress: 0, done: 0, not_required: 0, failed: 0 });
    }
    if (!offboardingIds.length) return result;
    const rows = (await OffboardingTask.findAll({
      where: { offboardingId: { [Op.in]: offboardingIds } },
      attributes: ["offboardingId", "status", [sequelize.fn("COUNT", sequelize.col("id")), "total"]],
      group: ["offboardingId", "status"],
      raw: true,
    })) as unknown as { offboardingId: number; status: TaskStatus; total: string | number }[];
    for (const row of rows) {
      const counts = result.get(row.offboardingId);
      if (counts && STATUSES.includes(row.status)) counts[row.status] = Number(row.total);
    }
    return result;
  }

  private async summary(offboarding: CompanyOffboarding, counts: TaskCounts) {
    return {
      id: offboarding.id,
      userId: offboarding.userId,
      memberEmail: offboarding.memberEmail,
      status: offboarding.status,
      startedAt: offboarding.startedAt,
      completedAt: offboarding.completedAt ?? null,
      counts,
      keysRotated: await this.keysRotated(offboarding.companyId, offboarding.userId),
    };
  }

  async list(companyId: number, managerId: number) {
    await this.requireManager(companyId, managerId);
    let rows = await CompanyOffboarding.findAll({ where: { companyId }, order: [["id", "DESC"]] });
    // Keys can go without a rotation (a collection deleted, a person removed from it): catch up here.
    const open = rows.filter((row) => row.status === "in_progress");
    let finished = false;
    for (const row of open) finished = (await this.completeQuietly(row, managerId)) || finished;
    if (finished) rows = await CompanyOffboarding.findAll({ where: { companyId }, order: [["id", "DESC"]] });
    const counts = await this.countsFor(rows.map((row) => row.id));
    return Promise.all(rows.map((row) => this.summary(row, counts.get(row.id) as TaskCounts)));
  }

  async detail(companyId: number, managerId: number, offboardingId: number, status?: string, page = 1) {
    await this.requireManager(companyId, managerId);
    let offboarding = await this.requireOffboarding(companyId, offboardingId);
    if (await this.completeQuietly(offboarding, managerId)) offboarding = await this.requireOffboarding(companyId, offboardingId);
    if (status && !STATUSES.includes(status as TaskStatus)) fail(400, "Unknown status");
    const where: Record<string, unknown> = { offboardingId };
    if (status) where.status = status;
    const { rows, count } = await OffboardingTask.findAndCountAll({
      where,
      attributes: ["id", "noteId", "status", "reference", "note", "actorId", "updatedAt"],
      order: [["id", "ASC"]],
      limit: PAGE,
      offset: (Math.max(1, page) - 1) * PAGE,
    });
    const counts = (await this.countsFor([offboardingId])).get(offboardingId) as TaskCounts;
    return {
      offboarding: await this.summary(offboarding, counts),
      tasks: rows.map((task) => ({
        id: task.id,
        noteId: task.noteId ?? null,
        status: task.status,
        reference: task.reference ?? null,
        note: task.note ?? null,
        actorId: task.actorId ?? null,
        updatedAt: task.updatedAt,
      })),
      total: count,
    };
  }

  async updateTasks(
    companyId: number,
    managerId: number,
    offboardingId: number,
    input: { taskIds?: unknown; status?: unknown; reference?: unknown; note?: unknown }
  ) {
    await this.requireManager(companyId, managerId);
    const offboarding = await this.requireOffboarding(companyId, offboardingId);
    const ids = Array.isArray(input?.taskIds) ? input.taskIds : [];
    if (!ids.length || ids.length > 100 || !ids.every((id) => Number.isInteger(id) && id > 0)) {
      fail(400, "Pick between 1 and 100 tasks");
    }
    if (!STATUSES.includes(input.status as TaskStatus)) fail(400, "Unknown status");
    const status = input.status as TaskStatus;
    const changes: { status: TaskStatus; actorId: number; reference?: string | null; note?: string | null } = {
      status,
      actorId: managerId,
    };
    if (input.reference !== undefined) {
      if (typeof input.reference !== "string" || input.reference.length > 200) {
        fail(400, "The reference can be at most 200 characters");
      }
      changes.reference = input.reference || null;
    }
    if (input.note !== undefined) {
      if (typeof input.note !== "string" || input.note.length > 500) {
        fail(400, "The note can be at most 500 characters");
      }
      changes.note = input.note || null;
    }
    // Only this offboarding's tasks: ids from elsewhere are ignored.
    const [updated] = await OffboardingTask.update(changes, {
      where: { id: { [Op.in]: ids as number[] }, offboardingId },
    });
    await AuditService.record({
      actorId: managerId,
      action: "offboarding_task_updated",
      companyId,
      targetUserId: offboarding.userId,
      details: { offboardingId, count: updated, status },
    });
    await this.completeIfDone(offboarding, managerId);
    const fresh = await this.requireOffboarding(companyId, offboardingId);
    const counts = (await this.countsFor([offboardingId])).get(offboardingId) as TaskCounts;
    return { updated, offboarding: await this.summary(fresh, counts) };
  }

  /**
   * Someone who may edit the item saved a new password for it in 2keevo
   * (reported by their browser: the server can't read the item). Updating the
   * stored password is the last step of changing it at the source, so the
   * item's open tasks in open offboardings are marked done. Failed or already
   * resolved tasks are left as they are. Returns how many tasks changed.
   */
  async markPasswordChanged(noteId: number, actorId: number) {
    const open = ["pending", "in_progress"] as TaskStatus[];
    const tasks = await OffboardingTask.findAll({
      where: { noteId, status: { [Op.in]: open } },
      attributes: ["offboardingId"],
    });
    const ids = [...new Set(tasks.map((task) => task.offboardingId))];
    if (!ids.length) return 0;
    const offboardings = await CompanyOffboarding.findAll({ where: { id: { [Op.in]: ids }, status: "in_progress" } });
    if (!offboardings.length) return 0;
    const [updated] = await OffboardingTask.update(
      { status: "done", actorId, note: AUTO_DONE_NOTE },
      { where: { noteId, offboardingId: { [Op.in]: offboardings.map((row) => row.id) }, status: { [Op.in]: open } } }
    );
    for (const offboarding of offboardings) {
      await AuditService.record({
        actorId,
        action: "offboarding_task_updated",
        companyId: offboarding.companyId,
        targetUserId: offboarding.userId,
        noteId,
        details: { offboardingId: offboarding.id, count: updated, status: "done", automatic: true },
      });
      await this.completeQuietly(offboarding, actorId);
    }
    return updated;
  }

  /** After a collection key was replaced: finish any open offboarding that is now done. */
  async completeOpenFor(companyId: number, actorId: number | null) {
    const open = await CompanyOffboarding.findAll({ where: { companyId, status: "in_progress" } });
    for (const offboarding of open) {
      // One failing offboarding must not stop the others.
      try {
        await this.completeIfDone(offboarding, actorId);
      } catch (error) {
        console.error("Error completing offboarding:", error);
      }
    }
  }

  /** completeIfDone for a side path: a failure here must not fail what the caller did. */
  private async completeQuietly(offboarding: CompanyOffboarding, actorId: number | null) {
    try {
      return await this.completeIfDone(offboarding, actorId);
    } catch (error) {
      console.error("Error completing offboarding:", error);
      return false;
    }
  }

  private async completeIfDone(offboarding: CompanyOffboarding, actorId: number | null) {
    if (offboarding.status !== "in_progress") return false;
    const counts = (await this.countsFor([offboarding.id])).get(offboarding.id) as TaskCounts;
    if (!this.isComplete(counts)) return false;
    const now = new Date();
    const won = await sequelize.transaction(async (transaction) => {
      // Two checks at once: only the one that flips in_progress completes it.
      const [changed] = await CompanyOffboarding.update(
        { status: "complete", completedAt: now },
        { where: { id: offboarding.id, status: "in_progress" }, transaction }
      );
      if (!changed) return false;
      await CompanyMember.update(
        { status: "removed", removedAt: now },
        { where: { companyId: offboarding.companyId, userId: offboarding.userId, status: "suspended" }, transaction }
      );
      return true;
    });
    if (!won) return false;
    await AuditService.record({
      actorId,
      action: "offboarding_completed",
      companyId: offboarding.companyId,
      targetUserId: offboarding.userId,
      details: { offboardingId: offboarding.id },
    });
    return true;
  }

  private openFor(companyId: number, userId: number) {
    return CompanyOffboarding.findOne({
      where: { companyId, userId, status: "in_progress" },
      attributes: ["id"],
    });
  }

  /**
   * The company's items in these collections, plus its items shared to the
   * person directly. Trashed ones count: they could open those too.
   */
  private async workItems(companyId: number, userId: number, collectionIds: number[]) {
    const inCollections = await CollectionService.noteIdsForCollections(collectionIds, { paranoid: false });
    const shares = await NoteShare.findAll({
      where: {
        sharedWithUserId: userId,
        [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
      },
      attributes: ["noteId"],
    });
    const fromCollections = new Set(inCollections);
    const ids = [...new Set([...inCollections, ...shares.map((share) => share.noteId)])];
    if (!ids.length) return [];
    const notes = await Note.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ["id", "companyId"],
      order: [["id", "ASC"]],
      paranoid: false,
    });
    // A direct share counts only for this company's items (or ones still in its collections).
    const sharedOnly = notes.filter((note) => !fromCollections.has(note.id) && note.companyId !== companyId);
    const linked = sharedOnly.length
      ? await CollectionService.collectionsByNoteId(sharedOnly.map((note) => note.id))
      : new Map<number, { companyId: number | null }[]>();
    return notes.filter(
      (note) =>
        fromCollections.has(note.id) ||
        note.companyId === companyId ||
        (linked.get(note.id) || []).some((collection) => collection.companyId === companyId)
    );
  }
}

export default new OffboardingService();
