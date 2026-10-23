import { Request } from "express";
import logger from "jet-logger";
import { Op, WhereOptions } from "sequelize";
import AuditEvent from "../models/AuditEvent";
import Collection from "../models/Collection";
import CollectionShare from "../models/CollectionShare";
import CompanyMember from "../models/CompanyMember";
import Note from "../models/Note";
import User from "../models/User";
import CollectionService from "./CollectionService";

/** Every action the log knows. The vault app has a label for each. */
export const AUDIT_ACTIONS = [
  // Account
  "login",
  "login_failed",
  "two_factor_failed",
  "two_factor_enabled",
  "two_factor_disabled",
  "recovery_codes_regenerated",
  "passkey_added",
  "passkey_removed",
  "session_revoked",
  "other_sessions_revoked",
  "password_reset",
  // Items
  "item_created",
  "item_updated",
  "item_trashed",
  "item_restored",
  "item_moved",
  "trash_emptied",
  "field_revealed",
  "field_copied",
  "item_autofilled",
  "vault_exported",
  "vault_imported",
  // Sharing
  "item_shared",
  "item_share_revoked",
  "item_share_left",
  "collection_shared",
  "collection_share_revoked",
  "collection_left",
  // Company
  "member_invited",
  "member_removed",
  "member_role_changed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACCOUNT_ACTIONS: AuditAction[] = [
  "login",
  "login_failed",
  "two_factor_failed",
  "two_factor_enabled",
  "two_factor_disabled",
  "recovery_codes_regenerated",
  "passkey_added",
  "passkey_removed",
  "session_revoked",
  "other_sessions_revoked",
  "password_reset",
  "vault_exported",
  "vault_imported",
];

// Revealing the same field over and over is one event, not fifty.
const REPEAT_WINDOW_MS = 60 * 1000;
const REPEATABLE: AuditAction[] = ["field_revealed", "field_copied", "item_autofilled"];
const PAGE_SIZE = 50;

export interface AuditInput {
  actorId?: number | null;
  action: AuditAction;
  noteId?: number | null;
  collectionId?: number | null;
  companyId?: number | null;
  targetUserId?: number | null;
  /** Never put secret values here. Titles, field names, permissions only. */
  details?: Record<string, unknown>;
  req?: Request;
}

type AuditRow = AuditEvent & { actor?: User | null; target?: User | null };

function personName(user?: User | null) {
  return user ? user.fullName || user.username : null;
}

class AuditService {
  /**
   * Store one event. Logging must never break the request it describes, so
   * failures are written to the server log and swallowed.
   */
  async record(input: AuditInput) {
    try {
      let companyId = input.companyId ?? null;
      if (!companyId && input.noteId) {
        companyId = await this.companyForNote(input.noteId);
      }
      if (!companyId && input.collectionId) {
        const collection = await Collection.findByPk(input.collectionId, {
          attributes: ["companyId"],
        });
        companyId = collection?.companyId ?? null;
      }

      // Keep the title so the history stays readable after the item is gone.
      const details = { ...(input.details || {}) };
      if (input.noteId && details.title === undefined) {
        const note = await Note.findByPk(input.noteId, {
          paranoid: false,
          attributes: ["title"],
        });
        if (note) details.title = note.title;
      }
      if (input.collectionId && details.collectionName === undefined) {
        const collection = await Collection.findByPk(input.collectionId, {
          attributes: ["name"],
        });
        if (collection) details.collectionName = collection.name;
      }

      if (REPEATABLE.includes(input.action) && input.actorId) {
        const recent = await AuditEvent.findOne({
          where: {
            actorId: input.actorId,
            action: input.action,
            noteId: input.noteId ?? null,
            createdAt: { [Op.gt]: new Date(Date.now() - REPEAT_WINDOW_MS) },
          },
          order: [["createdAt", "DESC"]],
        });
        if (
          recent &&
          JSON.stringify(recent.details) === JSON.stringify(details)
        ) {
          return;
        }
      }

      await AuditEvent.create({
        actorId: input.actorId ?? null,
        action: input.action,
        noteId: input.noteId ?? null,
        collectionId: input.collectionId ?? null,
        companyId,
        targetUserId: input.targetUserId ?? null,
        details,
        ip: input.req?.ip?.slice(0, 100) ?? null,
        userAgent: input.req?.get("user-agent")?.slice(0, 500) ?? null,
      });
    } catch (error) {
      logger.err(`Could not record audit event ${input.action}: ${error}`);
    }
  }

  /** History of one item: its owner, and company owners/admins for company items. */
  async noteHistory(noteId: number, userId: number, before?: number) {
    const note = await Note.findByPk(noteId, {
      paranoid: false,
      attributes: ["id", "userId"],
    });
    if (!note) return null;
    const companyId = await this.companyForNote(noteId);
    if (companyId) {
      if (!(await this.isManager(companyId, userId))) return null;
      // Only what happened while the item was in this company.
      return this.page({ noteId, companyId }, before);
    }
    if (note.userId !== userId) return null;
    // Only the item's personal history, and not other people's IP or browser.
    return this.page({ noteId, companyId: null }, before, userId);
  }

  /** Everything that happened in a company. Owners and admins only. */
  async companyLog(
    companyId: number,
    userId: number,
    options: { before?: number; action?: string; actorId?: number }
  ) {
    if (!(await this.isManager(companyId, userId))) return null;
    const where: Record<string, unknown> = { companyId };
    if (options.action && (AUDIT_ACTIONS as readonly string[]).includes(options.action)) {
      where.action = options.action;
    }
    if (options.actorId) where.actorId = options.actorId;
    return this.page(where, options.before);
  }

  /** Sign-ins and security changes on your own account. */
  async accountActivity(userId: number, before?: number) {
    return this.page(
      { actorId: userId, action: { [Op.in]: ACCOUNT_ACTIONS } },
      before
    );
  }

  /**
   * Before or after removing someone from a company: which company
   * collections they could open, and which secrets they revealed or copied.
   */
  async memberAccess(companyId: number, managerId: number, memberUserId: number) {
    if (!(await this.isManager(companyId, managerId))) return null;

    const collections = await Collection.findAll({
      where: { companyId },
      attributes: ["id", "name", "companyShare"],
      order: [["name", "ASC"]],
    });
    const shares = await CollectionShare.findAll({
      where: {
        sharedWithUserId: memberUserId,
        collectionId: { [Op.in]: collections.map((item) => item.id) },
      },
      attributes: ["collectionId", "permission"],
    });
    const shareByCollection = new Map(
      shares.map((share) => [share.collectionId, share.permission])
    );
    const member = await CompanyMember.findOne({
      where: { companyId, userId: memberUserId },
      attributes: ["role"],
    });
    const manager = member?.role === "owner" || member?.role === "admin";
    const accessible = collections
      .map((collection) => ({
        id: collection.id,
        name: collection.name,
        permission: manager
          ? "edit"
          : shareByCollection.get(collection.id) || collection.companyShare || null,
      }))
      .filter((collection) => collection.permission);

    const touched = await AuditEvent.findAll({
      where: {
        companyId,
        actorId: memberUserId,
        action: { [Op.in]: ["field_revealed", "field_copied", "item_autofilled"] },
        noteId: { [Op.not]: null },
      },
      attributes: ["noteId", "action", "createdAt", "details"],
      order: [["createdAt", "DESC"]],
      limit: 1000,
    });
    const byNote = new Map<
      number,
      { noteId: number; title: string; count: number; lastAt: Date }
    >();
    for (const event of touched) {
      const noteId = event.noteId as number;
      const entry = byNote.get(noteId) || {
        noteId,
        title: String(event.details?.title || "Item"),
        count: 0,
        lastAt: event.createdAt,
      };
      entry.count += 1;
      byNote.set(noteId, entry);
    }

    return { collections: accessible, secretsAccessed: [...byNote.values()] };
  }

  /** `viewerId`: hide IP and browser of events done by anyone else. */
  private async page(where: WhereOptions, before?: number, viewerId?: number) {
    const rows = (await AuditEvent.findAll({
      where: before ? { ...where, id: { [Op.lt]: before } } : where,
      include: [
        { model: User, as: "actor", attributes: ["id", "username", "fullName"] },
        { model: User, as: "target", attributes: ["id", "username", "fullName"] },
      ],
      order: [["id", "DESC"]],
      limit: PAGE_SIZE + 1,
    })) as AuditRow[];

    const events = rows.slice(0, PAGE_SIZE).map((row) => {
      const private_ = viewerId !== undefined && row.actorId !== viewerId;
      return {
      id: row.id,
      action: row.action,
      actorId: row.actorId,
      actorName: personName(row.actor),
      targetUserId: row.targetUserId,
      targetName: personName(row.target),
      noteId: row.noteId,
      collectionId: row.collectionId,
      details: row.details,
      ip: private_ ? null : row.ip,
      userAgent: private_ ? null : row.userAgent,
      createdAt: row.createdAt,
      };
    });
    return {
      events,
      next: rows.length > PAGE_SIZE ? events[events.length - 1].id : null,
    };
  }

  private async companyForNote(noteId: number) {
    const linked = await CollectionService.collectionsByNoteId([noteId]);
    return (
      (linked.get(noteId) || []).find((collection) => collection.companyId)
        ?.companyId ?? null
    );
  }

  private async isManager(companyId: number, userId: number) {
    const member = await CompanyMember.findOne({
      where: {
        companyId,
        userId,
        status: "active",
        role: { [Op.in]: ["owner", "admin"] },
      },
    });
    return Boolean(member);
  }
}

export default new AuditService();
