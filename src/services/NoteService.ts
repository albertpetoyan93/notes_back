import Note from "../models/Note";
import BreachResult from "../models/BreachResult";
import NoteShare, { SharePermission } from "../models/NoteShare";
import NoteFavorite from "../models/NoteFavorite";
import User from "../models/User";
import Collection from "../models/Collection";
import CollectionShare from "../models/CollectionShare";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import EmailService from "./EmailService";
import NotificationService from "./NotificationService";
import CollectionService, { type CollectionChange } from "./CollectionService";
import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import AccessService from "./AccessService";
import EntitlementService from "./EntitlementService";
import VersionService from "./VersionService";
import CompanyPolicyService from "./CompanyPolicyService";
import E2EItemService, { BLANK_FIELDS, assertEncData, assertSealed, collectionLabel } from "./E2EItemService";
import { isWorkItem, owningCompany } from "./workItems";

interface NoteFilters {
  category?: string;
  project?: string;
  tag?: string;
  search?: string;
  isFavorite?: boolean;
  sharedOnly?: boolean;
  trash?: boolean;
  collectionId?: number;
  companyId?: number;
}

interface CreateNoteData {
  category:
    | "note"
    | "password"
    | "login"
    | "command"
    | "ssh"
    | "db"
    | "address"
    | "card"
    | "other";
  isFavorite?: boolean;
  collectionId?: number | null;
  collectionIds?: number[];
  /** End-to-end item (stage 10.3): sealed in the browser. */
  e2e?: { e2eId: string; itemKey: string; encData: string } | null;
  /** Its first version, sealed with the item key. */
  version?: string;
  /** Key copies the browser made for its collections (see E2EItemService). */
  e2eKeys?: unknown;
}

interface UpdateNoteData {
  title?: string;
  content?: any;
  category?:
    | "note"
    | "password"
    | "login"
    | "command"
    | "ssh"
    | "db"
    | "address"
    | "card"
    | "other";
  project?: string;
  tags?: string[];
  isFavorite?: boolean;
  isEncrypted?: boolean;
  collectionId?: number | null;
  collectionIds?: number[];
  /** New sealed state of an end-to-end item, and the version to keep. */
  encData?: string;
  version?: string;
  e2eKeys?: unknown;
}

function storedCategory<T extends string | undefined>(category: T): T {
  return (category === "login" ? "password" : category) as T;
}

/**
 * Who may share an item or change its collections: the owner of a personal
 * item, anyone with edit access to a work item.
 */
export function canManage(
  access: {
    note: Pick<Note, "companyId" | "userId">;
    permission: "owner" | "edit" | "view";
    /** A work item, also one in company collections without a companyId yet (see isWorkItem). */
    work?: boolean;
  },
  userId: number
): boolean {
  const work = access.work ?? access.note.companyId != null;
  if (!work) return access.permission === "owner" && access.note.userId === userId;
  return access.permission === "edit";
}

/** The strongest permission these company collections give (an admin's "owner" counts as edit). */
function companyPermission(
  collections: { id: number }[],
  open: Map<number, "owner" | SharePermission>,
  permission: SharePermission | null = null
) {
  for (const collection of collections) {
    const fromOpen = open.get(collection.id);
    if (!fromOpen) continue;
    const fromCollection = fromOpen === "owner" ? "edit" : fromOpen;
    if (!permission || (permission === "view" && fromCollection === "edit")) {
      permission = fromCollection;
    }
  }
  return permission;
}

/** A readable item sent to the server: refused since stage 10.6 (the app seals items first). */
const e2eRequired = () =>
  Object.assign(new Error("Unlock your vault and try again."), { status: 409, code: "e2e_required" });

class NoteService {
  /**
   * A requested collection change, checked against the ownership rules, or
   * null when there is none (or the caller may not make it).
   */
  private async collectionChange(
    note: Note,
    permission: SharePermission | "owner",
    userId: number,
    data: { collectionId?: number | null; collectionIds?: number[] }
  ) {
    const ids = this.requestedCollectionIds(data);
    if (!ids) return null;
    const current = (await CollectionService.collectionsByNoteId([note.id])).get(note.id);
    if (!canManage({ note, permission, work: isWorkItem(note, current) }, userId)) return null;
    for (const collectionId of ids) {
      await CollectionService.assertCanAdd(collectionId, userId);
    }
    const change = await CollectionService.checkNoteCollections(note, ids, current);
    await this.assertCanLeave(note, current, ids, userId);
    return change;
  }

  /**
   * A work item can leave a collection only for someone who can edit that
   * collection, so saving through one collection never drops another.
   */
  private async assertCanLeave(
    note: Pick<Note, "companyId">,
    current: { id: number; companyId?: number | null }[] | undefined,
    nextIds: number[],
    userId: number
  ) {
    if (!isWorkItem(note, current)) return;
    for (const collection of current || []) {
      if (nextIds.includes(collection.id)) continue;
      const access = await CollectionService.getAccess(collection.id, userId);
      if (access?.permission !== "owner" && access?.permission !== "edit") {
        throw Object.assign(new Error("You can't remove this item from a collection you can't edit."), {
          status: 403,
        });
      }
    }
  }

  /** Links the note to its new collections and company, in one transaction. */
  private async commitCollections(note: Note, change: CollectionChange, userId: number) {
    await CollectionService.commitNoteCollections(note, change, userId, (transaction) =>
      CollectionService.setNoteCollections(note.id, change.ids, transaction)
    );
  }

  private requestedCollectionIds(data: {
    collectionId?: number | null;
    collectionIds?: number[];
  }) {
    if (Array.isArray(data.collectionIds)) {
      return [
        ...new Set(
          data.collectionIds
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0)
        ),
      ];
    }
    if (data.collectionId === undefined) return undefined;
    const id = Number(data.collectionId);
    return Number.isInteger(id) && id > 0 ? [id] : [];
  }

  private activeShareFilter(where: Record<string, unknown>) {
    return {
      ...where,
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
    };
  }

  private collectionInclude() {
    return [
      {
        model: Collection,
        as: "collection",
        attributes: ["id", "name", "encName", "companyId"],
        required: false,
      },
    ];
  }

  private noteIncludes() {
    return [
      ...this.collectionInclude(),
      {
        model: User,
        as: "user",
        attributes: ["id", "username", "fullName"],
        required: false,
      },
    ];
  }

  private async getAccessMaps(userId: number) {
    const noteShares = await NoteShare.findAll({
      where: this.activeShareFilter({ sharedWithUserId: userId }),
      attributes: ["noteId", "permission"],
    });
    const collectionShares = await CollectionShare.findAll({
      where: this.activeShareFilter({ sharedWithUserId: userId }),
      attributes: ["collectionId", "permission"],
    });

    const permissionByNoteId = new Map<number, SharePermission>();
    const collectionsBySharedNote = await CollectionService.collectionsByNoteId(
      noteShares.map((share) => share.noteId)
    );
    const activeCompanies = await CollectionService.activeCompanyIds(userId);
    noteShares.forEach((share) => {
      const companyIds = (collectionsBySharedNote.get(share.noteId) || [])
        .map((collection) => collection.companyId)
        .filter((companyId): companyId is number => !!companyId);
      if (
        companyIds.length &&
        !companyIds.some((companyId) => activeCompanies.has(companyId))
      ) {
        return;
      }
      permissionByNoteId.set(share.noteId, share.permission);
    });

    const permissionByCollectionId = new Map<number, SharePermission>();
    collectionShares.forEach((share) => {
      permissionByCollectionId.set(share.collectionId, share.permission);
    });

    const sharedCollectionIds = [...permissionByCollectionId.keys()];
    const personalSharedCollectionIds = sharedCollectionIds.length
      ? (
          await Collection.findAll({
            where: {
              id: { [Op.in]: sharedCollectionIds },
              companyId: { [Op.is]: null },
            },
            attributes: ["id"],
          })
        ).map((collection) => collection.id)
      : [];
    if (personalSharedCollectionIds.length) {
      const links = await CollectionService.linksForCollections(
        personalSharedCollectionIds
      );
      links.forEach((link) => {
        const fromCollection = permissionByCollectionId.get(link.collectionId);
        if (!fromCollection) return;
        const existing = permissionByNoteId.get(link.noteId);
        if (!existing || (existing === "view" && fromCollection === "edit")) {
          permissionByNoteId.set(link.noteId, fromCollection);
        }
      });
    }

    const ownedCollections = await Collection.findAll({
      where: { userId, companyId: { [Op.is]: null } },
      attributes: ["id"],
    });
    const ownedCollectionIds = ownedCollections.map((collection) => collection.id);
    if (ownedCollectionIds.length) {
      const links = await CollectionService.linksForCollections(ownedCollectionIds);
      const noteIds = [...new Set(links.map((link) => link.noteId))];
      const notes = noteIds.length
        ? await Note.findAll({
            where: { id: { [Op.in]: noteIds }, userId: { [Op.ne]: userId } },
            attributes: ["id"],
          })
        : [];
      notes.forEach((note) => {
        const existing = permissionByNoteId.get(note.id);
        if (!existing || existing === "view") {
          permissionByNoteId.set(note.id, "edit");
        }
      });
    }

    return {
      sharedNoteIds: [...permissionByNoteId.keys()],
      permissionByNoteId,
      ownedCollectionIds,
    };
  }

  /**
   * permissionByNoteId with each work item's permission taken from company
   * access (its open company collections, or a share), like anyone else's.
   */
  private async withWorkPermissions(
    userId: number,
    notes: Note[],
    collectionsByNoteId: Map<number, { id: number; companyId: number | null }[]>,
    permissionByNoteId: Map<number, SharePermission>
  ) {
    const work = notes.filter((note) => isWorkItem(note, collectionsByNoteId.get(note.id)));
    if (!work.length) return permissionByNoteId;
    const open = await CollectionService.openCompanyCollections(userId);
    const result = new Map(permissionByNoteId);
    for (const note of work) {
      const permission = companyPermission(
        collectionsByNoteId.get(note.id) || [],
        open,
        permissionByNoteId.get(note.id) || null
      );
      if (permission) result.set(note.id, permission);
      else result.delete(note.id);
    }
    return result;
  }

  /** The same for one item whose access was just resolved (getNoteAccess). */
  private withAccessPermission(
    access: { note: Note; permission: "owner" | SharePermission },
    collections: { companyId: number | null }[] | undefined,
    permissionByNoteId: Map<number, SharePermission>
  ) {
    if (!isWorkItem(access.note, collections) || access.permission === "owner") return permissionByNoteId;
    return new Map(permissionByNoteId).set(access.note.id, access.permission);
  }

  private async getSharedNoteIds(userId: number) {
    const maps = await this.getAccessMaps(userId);
    return maps;
  }

  private async getFavoriteNoteIds(userId: number) {
    const rows = await NoteFavorite.findAll({
      where: { userId },
      attributes: ["noteId"],
    });
    return new Set(rows.map((row) => row.noteId));
  }

  private async setUserFavorite(userId: number, noteId: number, favorite: boolean) {
    const existing = await NoteFavorite.findOne({ where: { userId, noteId } });
    if (favorite && !existing) {
      await NoteFavorite.create({ userId, noteId });
    }
    if (!favorite && existing) {
      await existing.destroy();
    }
  }

  private annotateNote(
    note: Note,
    userId: number,
    permissionByNoteId: Map<number, SharePermission>,
    favoriteNoteIds?: Set<number>,
    collections?: { id: number; name: string; companyId: number | null }[],
  ) {
    // A work item has no owner: its permission comes from permissionByNoteId.
    const isOwner = note.userId === userId && !isWorkItem(note, collections);
    const permission = isOwner
      ? "owner"
      : permissionByNoteId.get(note.id) || "view";

    const json = note.toJSON() as any;
    const owner = json.user;
    delete json.user;
    const linked = collections?.length
      ? collections
      : json.collection
        ? [
            {
              id: json.collection.id,
              name: json.collection.encName ? "" : json.collection.name,
              companyId: json.collection.companyId ?? null,
            },
          ]
        : [];
    json.collections = linked;
    json.collection = linked[0] || null;
    json.collectionId = linked[0]?.id ?? null;
    // The server holds no readable content (stage 10.6): a sealed item's data is in encData, and
    // `content` may still hold the old server-encrypted placeholder until migration 057 runs.
    json.content = {};
    if (!isOwner) {
      json.sharedByName = owner?.fullName || owner?.username || "Someone";
    }
    return {
      ...json,
      isOwner,
      permission,
      isShared: !isOwner,
      isFavorite: favoriteNoteIds?.has(note.id) ?? false,
    };
  }

  /**
   * Get all notes for a user (owned + shared) with optional filters
   */
  async getNotes(userId: number, filters?: NoteFilters) {
    await this.purgeOldTrash(userId);
    const { sharedNoteIds, permissionByNoteId, ownedCollectionIds } =
      await this.getAccessMaps(userId);

    let whereClause: any;

    if (filters?.companyId) {
      let companyCollections: { id: number; permission?: string | null }[] = [];
      try {
        companyCollections = await CollectionService.listForCompany(
          filters.companyId,
          userId
        );
      } catch (error: any) {
        if (error?.status === 404 || error?.status === 403) return [];
        throw error;
      }
      // Admins see every vault on the company page (permission null = no access): only opened ones list items (ADR-002, SEC06).
      const ids = companyCollections.filter((collection) => collection.permission).map((collection) => collection.id);
      const selected =
        filters.collectionId && ids.includes(filters.collectionId)
          ? [filters.collectionId]
          : filters.collectionId
            ? []
            : ids;
      let noteIds = await CollectionService.noteIdsForCollections(selected);
      if (filters.trash) noteIds = await this.trashedWorkItemIds(userId, noteIds);
      whereClause = {
        id: { [Op.in]: noteIds.length ? noteIds : [-1] },
        ...(filters.trash ? { deletedAt: { [Op.not]: null } } : {}),
      };
    } else if (filters?.collectionId) {
      const access = await CollectionService.getAccess(
        filters.collectionId,
        userId
      );
      if (!access) return [];
      let noteIds = await CollectionService.noteIdsForCollections([
        filters.collectionId,
      ]);
      if (filters?.trash && access.collection.companyId) {
        noteIds = await this.trashedWorkItemIds(userId, noteIds);
      }
      whereClause = {
        id: { [Op.in]: noteIds.length ? noteIds : [-1] },
      };
      if (filters?.trash) {
        // A company collection's trash: the work items you can manage, whoever made them.
        if (!access.collection.companyId) whereClause.userId = userId;
        whereClause.deletedAt = { [Op.not]: null };
      }
      if (filters?.sharedOnly) {
        whereClause.userId = { [Op.ne]: userId };
      }
    } else {
      whereClause = filters?.trash
        ? { userId, deletedAt: { [Op.not]: null } }
        : filters?.sharedOnly
          ? sharedNoteIds.length
            ? { id: { [Op.in]: sharedNoteIds } }
            : { id: { [Op.in]: [-1] } }
          : {
              [Op.or]: [
                { userId },
                ...(sharedNoteIds.length
                  ? [{ id: { [Op.in]: sharedNoteIds } }]
                  : []),
                ...(ownedCollectionIds.length
                  ? [{ collectionId: { [Op.in]: ownedCollectionIds } }]
                  : []),
              ],
            };
    }

    if (filters?.category && filters.category !== "all") {
      whereClause.category = storedCategory(filters.category);
    }

    const andClauses = [...(whereClause[Op.and] || [])];

    if (!filters?.companyId && !filters?.collectionId) {
      andClauses.push(
        sequelize.literal(`(
          "Note"."companyId" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "collection_notes" cn
            JOIN "collections" c ON c.id = cn."collectionId"
            WHERE cn."noteId" = "Note"."id" AND c."companyId" IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM "collections" c
            WHERE c.id = "Note"."collectionId" AND c."companyId" IS NOT NULL
          )
        )`)
      );
    }

    if (filters?.isFavorite) {
      const favoriteIds = [...(await this.getFavoriteNoteIds(userId))];
      andClauses.push({
        id: { [Op.in]: favoriteIds.length ? favoriteIds : [-1] },
      });
    }

    // Search, tags and password health live in the browser: the server can't read items.

    if (andClauses.length) {
      whereClause[Op.and] = andClauses;
    }

    const notes = await Note.findAll({
      where: whereClause,
      include: this.noteIncludes(),
      paranoid: !filters?.trash,
      order: [[filters?.trash ? "deletedAt" : "updatedAt", "DESC"]],
    });

    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const collectionsByNoteId = await CollectionService.collectionsByNoteId(
      notes.map((note) => note.id)
    );

    // Shown to whoever manages access: the owner, or company owners/admins.
    const managedCompanies = await this.managedCompanyIds(userId);
    const accessCounts = await AccessService.countsByNote(
      notes
        .filter((note) => {
          const companyIds = (collectionsByNoteId.get(note.id) || [])
            .map((collection) => collection.companyId)
            .filter((id): id is number => !!id);
          return companyIds.length
            ? companyIds.some((id) => managedCompanies.has(id))
            : note.userId === userId;
        })
        .map((note) => note.id),
      managedCompanies
    );
    const directIds = await this.directlySharedIds(userId, notes.map((note) => note.id));
    const keyPaths = await E2EItemService.keyPathsFor(userId, notes);
    const permissions = await this.withWorkPermissions(userId, notes, collectionsByNoteId, permissionByNoteId);
    return notes
      .map((note) => {
        const annotated = this.withKeyPaths(
          this.annotateNote(note, userId, permissions, favoriteNoteIds, collectionsByNoteId.get(note.id)),
          keyPaths
        );
        const accessCount = accessCounts.get(note.id);
        const withAccess =
          accessCount === undefined ? annotated : { ...annotated, accessCount };
        const withDirect = annotated.isOwner
          ? withAccess
          : { ...withAccess, sharedDirectly: directIds.has(note.id) };
        return withDirect;
      });
  }

  /**
   * An end-to-end item opens with its owner's copy of the key (itemKey), or for
   * anyone else through a share or a collection (e2eKeys). Each person gets
   * only their own ways in.
   */
  private withKeyPaths<T extends { id: number; e2e?: boolean; isOwner: boolean; itemKey?: string | null }>(
    note: T,
    keyPaths: Map<number, unknown>
  ) {
    if (!note.e2e) return note;
    return {
      ...note,
      itemKey: note.isOwner ? note.itemKey : null,
      e2eKeys: keyPaths.get(note.id) || { collections: [] },
    };
  }

  /**
   * Get a single note by ID if user owns it or it was shared with them
   */
  async getNoteById(noteId: number, userId: number) {
    const access = await this.getNoteAccess(noteId, userId);
    if (!access) return null;

    const { permissionByNoteId } = await this.getAccessMaps(userId);
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const collections = await CollectionService.collectionsByNoteId([
      access.note.id,
    ]);
    const annotated = this.withKeyPaths(
      this.annotateNote(
        access.note,
        userId,
        this.withAccessPermission(access, collections.get(access.note.id), permissionByNoteId),
        favoriteNoteIds,
        collections.get(access.note.id)
      ),
      await E2EItemService.keyPathsFor(userId, [access.note])
    );
    if (annotated.isOwner) return annotated;
    const directIds = await this.directlySharedIds(userId, [access.note.id]);
    return { ...annotated, sharedDirectly: directIds.has(access.note.id) };
  }

  /**
   * Items someone shared with you one by one (not through a collection).
   * Only those can be removed from your list on their own.
   */
  private async directlySharedIds(userId: number, noteIds: number[]) {
    if (!noteIds.length) return new Set<number>();
    const shares = await NoteShare.findAll({
      where: this.activeShareFilter({
        sharedWithUserId: userId,
        noteId: { [Op.in]: noteIds },
      }),
      attributes: ["noteId"],
    });
    return new Set(shares.map((share) => share.noteId));
  }

  /**
   * Backup of notes this user owns, with content already decrypted
   */
  async exportNotes(userId: number) {
    const notes = await Note.findAll({
      where: { userId },
      include: this.collectionInclude(),
      order: [["updatedAt", "DESC"]],
    });
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const collectionsByNoteId = await CollectionService.collectionsByNoteId(
      notes.map((note) => note.id)
    );
    const exported = [];
    let skipped = 0;

    for (const note of notes) {
      const linked = collectionsByNoteId.get(note.id) || [];
      if (isWorkItem(note, linked)) continue;
      // Only sealed items exist since stage 10.6; anything else is left out.
      if (!note.e2e) {
        skipped += 1;
        continue;
      }
      const names = linked.map(
        (collection) => collection.name
      );
      if (note.e2e) {
        // Opened by the browser, which holds the keys.
        exported.push({
          e2e: true,
          e2eId: note.e2eId,
          itemKey: note.itemKey,
          encData: note.encData,
          category: note.category,
          collection: names[0] || null,
          collections: names,
          // Encrypted names come empty: the app fills them in by id.
          collectionIds: linked.map((collection) => collection.id),
          isFavorite: favoriteNoteIds.has(note.id),
        });
      }
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      skipped,
      notes: exported,
    };
  }

  /**
   * The company's items, for its owner: works while the company is suspended, so the
   * items can always be taken out. End-to-end items come sealed with the owner's ways
   * in (their browser opens them); the file has the personal backup format.
   */
  async exportCompany(companyId: number, userId: number) {
    const owner = await CompanyMember.findOne({
      where: { companyId, userId, status: "active", role: "owner" },
    });
    if (!owner) {
      throw Object.assign(new Error("Only the company's owner can export its items"), { status: 403 });
    }
    // Only the vaults the owner can open: the role alone gives no content (ADR-002, SEC06).
    const open = await CollectionService.openCompanyCollections(userId);
    const collections = (await Collection.findAll({ where: { companyId }, attributes: ["id", "name", "encName"] })).filter(
      (collection) => open.has(collection.id)
    );
    const nameOf = new Map(collections.map((collection) => [collection.id, collectionLabel(collection)]));
    const noteIds = await CollectionService.noteIdsForCollections(collections.map((collection) => collection.id));
    const notes = noteIds.length
      ? await Note.findAll({ where: { id: { [Op.in]: noteIds } }, order: [["updatedAt", "DESC"]] })
      : [];
    const collectionsByNoteId = await CollectionService.collectionsByNoteId(notes.map((note) => note.id));
    const keyPaths = await E2EItemService.keyPathsFor(userId, notes);
    const exported = [];
    let skipped = 0;

    for (const note of notes) {
      const linkedHere = (collectionsByNoteId.get(note.id) || []).filter((collection) => nameOf.has(collection.id));
      const names = linkedHere.map((collection) => collection.name);
      if (note.e2e) {
        exported.push({
          e2e: true,
          e2eId: note.e2eId,
          // Company items never carry a creator copy, even a stale one.
          itemKey: null,
          e2eKeys: keyPaths.get(note.id) || { collections: [] },
          encData: note.encData,
          category: note.category,
          collection: names[0] || null,
          collections: names,
          // Encrypted names come empty: the app fills them in by id.
          collectionIds: linkedHere.map((collection) => collection.id),
        });
      } else {
        // Only sealed items exist since stage 10.6; anything else is left out.
        skipped += 1;
      }
    }

    return { version: 1, exportedAt: new Date().toISOString(), skipped, notes: exported };
  }

  /**
   * Create a new note
   */
  async createNote(userId: number, data: CreateNoteData) {
    // Stage 10.6: items arrive sealed by the browser; the server can't take a readable one.
    if (!data.e2e) throw e2eRequired();
    const requested = this.requestedCollectionIds(data);
    if (requested?.length) {
      for (const collectionId of requested) {
        await CollectionService.assertCanAdd(collectionId, userId);
      }
    }
    const companyId = owningCompany(await CollectionService.collectionRefs(requested || []));
    return this.createSealed(userId, data, requested || [], companyId);
  }

  /** A new end-to-end item: the server stores what the browser sealed. */
  private async createSealed(userId: number, data: CreateNoteData, collectionIds: number[], companyId: number | null) {
    const work = companyId !== null;
    // An older app also wraps the key for its creator; a company item must not have that copy.
    if (work && data.e2e?.itemKey) {
      throw Object.assign(new Error("Update 2keevo: company items are saved without a personal key copy."), {
        status: 400,
      });
    }
    const sealed = assertSealed(data.e2e, { work });
    const version = data.version ? assertEncData(data.version, "version") : null;
    const itemKeys = await E2EItemService.ensureNew(userId, sealed.e2eId, collectionIds, data.e2eKeys, { work });
    // One transaction: a company item without its collection key copies could never be opened.
    const note = await sequelize.transaction(async (transaction) => {
      if (work) {
        // A key replacement (rotate) locks the collection for update: it can't land while this holds.
        await Collection.findAll({
          where: { id: { [Op.in]: collectionIds } },
          attributes: ["id"],
          transaction,
          lock: transaction.LOCK.SHARE,
        });
      }
      const created = await Note.create(
        {
          ...BLANK_FIELDS,
          ...sealed,
          e2e: true,
          category: storedCategory(data.category) || "note",
          collectionId: null,
          userId,
          companyId,
        },
        { transaction }
      );
      if (collectionIds.length) await CollectionService.setNoteCollections(created.id, collectionIds, transaction);
      await E2EItemService.storeNewItemKeys(created.id, itemKeys, transaction);
      // A collection key replaced since the copies were made: with no creator copy nobody could open it.
      if (work && !(await E2EItemService.coversCollections(created.id, collectionIds, transaction))) {
        throw Object.assign(new Error("A collection key changed meanwhile. Try again."), { status: 409 });
      }
      return created;
    });
    if (version) await this.keepSealedVersion(note.id, userId, version);
    if (data.isFavorite) await this.setUserFavorite(userId, note.id, true);
    return this.annotateSaved(note, userId);
  }

  /**
   * Save an end-to-end item (its owner, or someone it's shared with to edit).
   * The readable fields (title, content…) are never written: they would leak it.
   */
  private async updateSealed(note: Note, userId: number, data: UpdateNoteData, permission: SharePermission | "owner") {
    if (data.title !== undefined || data.content !== undefined || data.tags !== undefined) {
      throw Object.assign(new Error("This item is end-to-end encrypted. Reload the page and try again."), {
        status: 409,
      });
    }
    const encData = data.encData !== undefined ? assertEncData(data.encData) : undefined;
    const version = data.version ? assertEncData(data.version, "version") : null;
    const change = await this.collectionChange(note, permission, userId, data);
    if (change) {
      await E2EItemService.ensure(userId, [note.id], data.e2eKeys, {
        collectionsByNote: new Map([[note.id, change.ids]]),
      });
      // First: a refused move must not save the edit anyway.
      await this.commitCollections(note, change, userId);
    }
    await note.update({
      ...(encData ? { encData } : {}),
      ...(data.category !== undefined ? { category: storedCategory(data.category) } : {}),
    });
    if (version) await this.keepSealedVersion(note.id, userId, version);
    // Favorites are per person: anyone saving a work item may set theirs here.
    if (data.isFavorite !== undefined && (permission === "owner" || isWorkItem(note))) {
      await this.setUserFavorite(userId, note.id, Boolean(data.isFavorite));
    }
    return this.annotateSaved(note, userId, permission);
  }

  /** The saved item as the list shows it, with the caller's ways in. */
  private async annotateSaved(note: Note, userId: number, permission: SharePermission | "owner" = "owner") {
    const saved = await Note.findByPk(note.id, { include: this.collectionInclude() });
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const collections = await CollectionService.collectionsByNoteId([note.id]);
    const permissionByNoteId = new Map<number, SharePermission>();
    if (permission !== "owner") permissionByNoteId.set(note.id, permission);
    // A work item (new, or just moved into a company) shows the caller's company access.
    const permissions = await this.withWorkPermissions(userId, [saved || note], collections, permissionByNoteId);
    return this.withKeyPaths(
      this.annotateNote(saved || note, userId, permissions, favoriteNoteIds, collections.get(note.id)),
      await E2EItemService.keyPathsFor(userId, [saved || note])
    );
  }

  // History must never stop a save; a failure is logged instead.
  private async keepSealedVersion(noteId: number, userId: number, encData: string) {
    try {
      await VersionService.storeSealed(noteId, encData, userId);
    } catch (error: any) {
      console.error("Could not keep a version of item", noteId, error?.message || error);
    }
  }

  /**
   * Update a note (owner or edit permission)
   */
  async updateNote(noteId: number, userId: number, data: UpdateNoteData) {
    const access = await this.getNoteAccess(noteId, userId);
    if (
      !access ||
      (access.permission !== "owner" && access.permission !== "edit")
    ) {
      return null;
    }

    const note = access.note;
    if (!note.e2e) throw e2eRequired();
    return this.updateSealed(note, userId, data, access.permission);
  }

  /** Who may see and restore versions: the people who may edit the item. */
  private async versionAccess(noteId: number, userId: number) {
    const access = await this.getNoteAccess(noteId, userId);
    if (!access || (access.permission !== "owner" && access.permission !== "edit")) {
      return null;
    }
    return access;
  }

  async listVersions(noteId: number, userId: number) {
    if (!(await this.versionAccess(noteId, userId))) return null;
    return VersionService.list(noteId);
  }

  async getVersion(noteId: number, versionId: number, userId: number) {
    if (!(await this.versionAccess(noteId, userId))) return null;
    return VersionService.get(noteId, versionId);
  }

  /** Old extensions still ask (stage 10.6): readable items are gone, so nothing to match here. */
  async autofill(_userId: number, _host: string, _query = ""): Promise<any[]> {
    return [];
  }

  /**
   * The sealed (end-to-end) logins this person could fill, with their ways in:
   * the extension opens them and matches the site itself (stage 10.5). The
   * server can't: it can't read them.
   */
  async sealedAutofillItems(userId: number) {
    const noteIds = await this.autofillNoteIds(userId);
    const notes = noteIds.length
      ? await Note.findAll({
          where: { id: { [Op.in]: noteIds }, e2e: true },
          attributes: ["id", "userId", "companyId", "category", "e2e", "e2eId", "itemKey", "encData", "updatedAt"],
        })
      : [];
    const { permissionByNoteId } = await this.getAccessMaps(userId);
    const collectionsByNoteId = await CollectionService.collectionsByNoteId(notes.map((note) => note.id));
    const permissions = await this.withWorkPermissions(userId, notes, collectionsByNoteId, permissionByNoteId);
    const keyPaths = await E2EItemService.keyPathsFor(userId, notes);
    return notes.map((note) => {
      // A work item has no owner and no creator copy of its key.
      const isOwner = note.userId === userId && !isWorkItem(note, collectionsByNoteId.get(note.id));
      return {
        id: note.id,
        title: "",
        category: note.category,
        content: {},
        isOwner,
        permission: isOwner ? "owner" : permissions.get(note.id) || "view",
        e2e: true,
        e2eId: note.e2eId,
        encData: note.encData,
        itemKey: isOwner ? note.itemKey : null,
        e2eKeys: keyPaths.get(note.id) || { collections: [] },
        updatedAt: note.updatedAt,
      };
    });
  }

  /** Old extensions still ask (stage 10.6): sealed items carry their passkeys, matched in the extension. */
  async passkeysForSite(_userId: number, _host: string): Promise<any[]> {
    return [];
  }

  private async autofillNoteIds(userId: number) {
    const { sharedNoteIds } = await this.getAccessMaps(userId);
    const personalCandidates = await Note.findAll({
      where: {
        category: { [Op.in]: ["password", "login"] },
        [Op.or]: [
          { userId },
          ...(sharedNoteIds.length ? [{ id: { [Op.in]: sharedNoteIds } }] : []),
        ],
      },
      attributes: ["id", "companyId"],
    });
    const collectionsByNote = await CollectionService.collectionsByNoteId(
      personalCandidates.map((note) => note.id)
    );
    // Work items come only through open company collections below, never as the creator's.
    const personalIds = personalCandidates
      .filter((note) => !isWorkItem(note, collectionsByNote.get(note.id)))
      .map((note) => note.id);

    const openCollections = await CollectionService.openCompanyCollections(userId);
    const companyNoteIds = await CollectionService.noteIdsForCollections([
      ...openCollections.keys(),
    ]);
    const companyIds = companyNoteIds.length
      ? (
          await Note.findAll({
            where: {
              id: { [Op.in]: companyNoteIds },
              category: { [Op.in]: ["password", "login"] },
            },
            attributes: ["id"],
          })
        ).map((note) => note.id)
      : [];

    return [...new Set([...personalIds, ...companyIds])];
  }

  /** When each personal login was last checked for leaks. */
  async breachStatus(userId: number) {
    const rows = await BreachResult.findAll({
      where: { userId },
      attributes: ["noteId", "count", "checkedAt"],
    });
    return {
      checkedAt: rows.length
        ? new Date(Math.max(...rows.map((row) => row.checkedAt.getTime())))
        : null,
      // Counts too: for end-to-end items the browser works out health itself.
      results: rows.map((row) => ({ noteId: row.noteId, count: row.count, checkedAt: row.checkedAt })),
    };
  }

  /**
   * Saves leak counts the browser worked out. Only for the caller's own
   * personal logins, the same ones the other health checks cover.
   */
  async saveBreachResults(userId: number, results: unknown) {
    if (!Array.isArray(results) || results.length > 5000) {
      throw Object.assign(new Error("Send up to 5000 results"), { status: 400 });
    }
    const counts = new Map<number, number>();
    for (const item of results as any[]) {
      const noteId = Number(item?.noteId);
      const count = Number(item?.count);
      if (!Number.isInteger(noteId) || !Number.isInteger(count) || count < 0) {
        throw Object.assign(new Error("Each result needs a noteId and a count"), { status: 400 });
      }
      counts.set(noteId, Math.min(count, 2_000_000_000));
    }
    if (!counts.size) return { saved: 0 };

    const owned = await Note.findAll({
      where: {
        id: { [Op.in]: [...counts.keys()] },
        userId,
        category: { [Op.in]: ["password", "login"] },
      },
      attributes: ["id"],
    });
    const checkedAt = new Date();
    await BreachResult.bulkCreate(
      owned.map((note) => ({
        userId,
        noteId: note.id,
        count: counts.get(note.id) || 0,
        checkedAt,
      })),
      { updateOnDuplicate: ["count", "checkedAt"], conflictAttributes: ["userId", "noteId"] }
    );
    return { saved: owned.length };
  }

  async purgeOldTrash(userId: number) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await sequelize.query(
      `DELETE FROM "notes"
       WHERE "userId" = :userId
         AND "companyId" IS NULL
         AND "deletedAt" IS NOT NULL
         AND "deletedAt" < :cutoff
         AND NOT EXISTS (
           SELECT 1 FROM "collection_notes" cn
           JOIN "collections" c ON c.id = cn."collectionId"
           WHERE cn."noteId" = "notes"."id" AND c."companyId" IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM "collections" c
           WHERE c.id = "notes"."collectionId" AND c."companyId" IS NOT NULL
         )`,
      { replacements: { userId, cutoff } }
    );
  }

  async emptyTrash(userId: number) {
    const [, metadata] = await sequelize.query(
      `DELETE FROM "notes"
       WHERE "userId" = :userId
         AND "companyId" IS NULL
         AND "deletedAt" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "collection_notes" cn
           JOIN "collections" c ON c.id = cn."collectionId"
           WHERE cn."noteId" = "notes"."id" AND c."companyId" IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM "collections" c
           WHERE c.id = "notes"."collectionId" AND c."companyId" IS NOT NULL
         )`,
      { replacements: { userId } }
    );
    return Number((metadata as { rowCount?: number })?.rowCount || 0);
  }

  async bulkUpdate(
    userId: number,
    noteIds: number[],
    action: "trash" | "move",
    collectionId?: number | null,
    e2eKeys?: unknown
  ) {
    const ids = [...new Set(noteIds.map(Number).filter((id) => !isNaN(id)))];
    if (!ids.length) {
      throw Object.assign(new Error("Choose at least one note"), { status: 400 });
    }

    const notes = await Note.findAll({
      where: { id: { [Op.in]: ids } },
    });

    const collectionsByNote = await CollectionService.collectionsByNoteId(
      notes.map((note) => note.id)
    );
    // Your personal items; work items only where you can manage them (edit access), whoever made them.
    const manageable = await this.manageableWorkItems(userId, notes, collectionsByNote);
    const editable = notes.filter((note) =>
      isWorkItem(note, collectionsByNote.get(note.id)) ? manageable.has(note.id) : note.userId === userId
    );
    if (!editable.length) {
      throw Object.assign(new Error("You can only change notes you own"), {
        status: 400,
      });
    }

    if (action === "trash") {
      for (const note of editable) {
        await note.destroy();
      }
      return {
        updated: editable.length,
        skipped: ids.length - editable.length,
        noteIds: editable.map((note) => note.id),
      };
    }

    const nextIds: number[] = [];
    if (collectionId) {
      const access = await CollectionService.assertCanAdd(collectionId, userId);
      nextIds.push(access.collection.id);
    }
    // Every item is checked before any moves, so a refusal changes nothing.
    const changes = new Map<number, CollectionChange>();
    for (const note of editable) {
      const change = await CollectionService.checkNoteCollections(note, nextIds, collectionsByNote.get(note.id));
      await this.assertCanLeave(note, collectionsByNote.get(note.id), nextIds, userId);
      changes.set(note.id, change);
    }
    await E2EItemService.ensure(
      userId,
      editable.map((note) => note.id),
      e2eKeys,
      { collectionsByNote: new Map(editable.map((note) => [note.id, nextIds])) }
    );

    for (const note of editable) {
      await this.commitCollections(note, changes.get(note.id)!, userId);
    }

    return {
      updated: editable.length,
      skipped: ids.length - editable.length,
      noteIds: editable.map((note) => note.id),
    };
  }

  /**
   * Delete a note (its owner; for a work item, anyone who can manage it)
   */
  async deleteNote(noteId: number, userId: number) {
    const access = await this.getNoteAccess(noteId, userId);
    if (!access || !canManage(access, userId)) {
      return false;
    }

    await access.note.destroy();
    return true;
  }

  /**
   * Restore a soft-deleted note (its owner; for a work item, anyone with edit
   * access through its company collections)
   */
  async restoreNote(noteId: number, userId: number) {
    const note = await Note.findOne({
      where: { id: noteId },
      paranoid: false,
    });

    if (!note || !note.deletedAt) {
      return false;
    }
    if (!(await this.manageAccess(noteId, userId, note))) {
      return false;
    }

    await note.restore();
    return true;
  }

  /**
   * Of these items, the work items this person can manage now: edit through
   * active company access (an open company collection, or a direct share
   * while active in the company). The rules of getNoteAccess + canManage, for
   * many items at once and for trashed ones too.
   */
  private async manageableWorkItems(
    userId: number,
    notes: Note[],
    collectionsByNote: Map<number, { id: number; companyId: number | null }[]>,
    open?: Map<number, "owner" | SharePermission>
  ) {
    const work = notes.filter((note) => isWorkItem(note, collectionsByNote.get(note.id)));
    if (!work.length) return new Set<number>();
    const openCollections = open || (await CollectionService.openCompanyCollections(userId));
    const activeCompanies = await CollectionService.activeCompanyIds(userId);
    const shares = await NoteShare.findAll({
      where: this.activeShareFilter({ noteId: { [Op.in]: work.map((note) => note.id) }, sharedWithUserId: userId }),
      attributes: ["noteId", "permission"],
    });
    const result = new Set<number>();
    for (const note of work) {
      const linked = collectionsByNote.get(note.id) || [];
      const inActiveCompany = [note.companyId, ...linked.map((collection) => collection.companyId)].some(
        (companyId) => companyId && activeCompanies.has(companyId)
      );
      const share = inActiveCompany ? shares.find((row) => row.noteId === note.id)?.permission : undefined;
      const permission = companyPermission(linked, openCollections, share || null);
      if (permission && canManage({ note, permission, work: true }, userId)) result.add(note.id);
    }
    return result;
  }

  /** Every work item this person can manage now (trashed ones too, with paranoid: false). */
  async manageableWorkItemIds(userId: number, options: { paranoid?: boolean } = {}) {
    const open = await CollectionService.openCompanyCollections(userId);
    const editable = [...open.entries()]
      .filter(([, permission]) => permission !== "view")
      .map(([collectionId]) => collectionId);
    const inCollections = editable.length ? await CollectionService.noteIdsForCollections(editable) : [];
    const shares = await NoteShare.findAll({
      where: this.activeShareFilter({ sharedWithUserId: userId, permission: "edit" }),
      attributes: ["noteId"],
    });
    const ids = [...new Set([...inCollections, ...shares.map((share) => share.noteId)])];
    if (!ids.length) return [];
    const notes = await Note.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ["id", "userId", "companyId"],
      paranoid: options.paranoid ?? true,
    });
    const collectionsByNote = await CollectionService.collectionsByNoteId(notes.map((note) => note.id));
    const manageable = await this.manageableWorkItems(userId, notes, collectionsByNote, open);
    return notes.filter((note) => manageable.has(note.id)).map((note) => note.id);
  }

  /** Of these items, the work items this person can manage (and so restore), trashed ones included. */
  private async trashedWorkItemIds(userId: number, noteIds: number[]) {
    if (!noteIds.length) return [];
    const manageable = new Set(await this.manageableWorkItemIds(userId, { paranoid: false }));
    return noteIds.filter((id) => manageable.has(id));
  }

  /**
   * Whether this person may manage an item now, trashed or not: its owner for
   * a personal item, edit through company access for a work item. Null when
   * they may not; otherwise whether it is a work item.
   */
  async manageAccess(noteId: number, userId: number, found?: Note | null) {
    const note = found || (await Note.findOne({ where: { id: noteId }, paranoid: false }));
    if (!note) return null;
    const collections = (await CollectionService.collectionsByNoteId([note.id])).get(note.id) || [];
    if (!isWorkItem(note, collections)) return note.userId === userId ? { work: false } : null;
    const manageable = await this.manageableWorkItems(userId, [note], new Map([[note.id, collections]]));
    return manageable.has(note.id) ? { work: true } : null;
  }

  /**
   * Get note statistics for a user
   */
  async getNoteStats(userId: number) {
    const totalNotes = await Note.count({ where: { userId } });
    const favoriteNotes = await NoteFavorite.count({ where: { userId } });

    const categoryCounts = await Note.findAll({
      where: { userId },
      attributes: [
        "category",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
      ],
      group: ["category"],
      raw: true,
    });

    return {
      total: totalNotes,
      favorites: favoriteNotes,
      byCategory: categoryCounts,
    };
  }

  /**
   * Toggle the current user's favorite flag.
   * Works for notes they own and notes shared with them.
   */
  async toggleFavorite(noteId: number, userId: number) {
    const access = await this.getNoteAccess(noteId, userId);
    if (!access) {
      return null;
    }

    const existing = await NoteFavorite.findOne({
      where: { noteId, userId },
    });
    await this.setUserFavorite(userId, noteId, !existing);

    const { permissionByNoteId } = await this.getSharedNoteIds(userId);
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const collections = await CollectionService.collectionsByNoteId([noteId]);
    return this.withKeyPaths(
      this.annotateNote(
        access.note,
        userId,
        this.withAccessPermission(access, collections.get(noteId), permissionByNoteId),
        favoriteNoteIds,
        collections.get(noteId)
      ),
      await E2EItemService.keyPathsFor(userId, [access.note])
    );
  }

  /**
   * Resolve access for a note
   */
  async getNoteAccess(noteId: number, userId: number) {
    const note = await Note.findByPk(noteId, {
      include: this.noteIncludes(),
    });
    if (!note) return null;

    const linked = await CollectionService.collectionsByNoteId([note.id]);
    const companyCollections = (linked.get(note.id) || []).filter(
      (collection) => collection.companyId
    );
    if (isWorkItem(note, companyCollections)) {
      return this.companyNoteAccess(note, userId, companyCollections);
    }

    if (note.userId === userId) {
      return { note, permission: "owner" as const };
    }

    let permission: SharePermission | null = null;
    const share = await NoteShare.findOne({
      where: this.activeShareFilter({ noteId, sharedWithUserId: userId }),
    });
    if (share) permission = share.permission;

    for (const collection of linked.get(note.id) || []) {
      const collectionAccess = await CollectionService.getAccess(
        collection.id,
        userId
      );
      if (!collectionAccess) continue;
      const fromCollection =
        collectionAccess.permission === "owner" ? "edit" : collectionAccess.permission;
      if (!permission || (permission === "view" && fromCollection === "edit")) {
        permission = fromCollection;
      }
    }

    if (!permission) return null;
    return { note, permission };
  }

  private async companyNoteAccess(
    note: Note,
    userId: number,
    companyCollections: { id: number; companyId?: number | null }[]
  ) {
    const open = await CollectionService.openCompanyCollections(userId);
    let permission = companyPermission(companyCollections, open);

    const share = await NoteShare.findOne({
      where: this.activeShareFilter({ noteId: note.id, sharedWithUserId: userId }),
    });
    if (share) {
      const activeCompanies = await CollectionService.activeCompanyIds(userId);
      const inActiveCompany = [note.companyId, ...companyCollections.map((collection) => collection.companyId)].some(
        (companyId) => companyId && activeCompanies.has(companyId)
      );
      if (
        inActiveCompany &&
        (!permission || (permission === "view" && share.permission === "edit"))
      ) {
        permission = share.permission;
      }
    }

    // The creator gets what their company access gives, like anyone else.
    if (!permission) return null;
    return { note, permission, work: true };
  }

  /**
   * Share a note with another user by email or username (owner only; for a
   * work item, anyone who can manage it)
   */
  async shareNote(
    noteId: number,
    ownerId: number,
    identifier: string,
    permission: SharePermission = "view",
    expiresAt: Date | null = null,
  ) {
    const access = await this.getNoteAccess(noteId, ownerId);
    if (!access || !canManage(access, ownerId)) {
      throw Object.assign(
        new Error("Note not found or you are not the owner"),
        {
          status: 404,
        },
      );
    }
    const note = access.note;

    const trimmed = identifier.trim();
    if (!trimmed) {
      throw Object.assign(new Error("Email or username is required"), {
        status: 400,
      });
    }

    const recipient = await User.findOne({
      where: {
        [Op.or]: [{ email: trimmed }, { username: trimmed }],
        // Unconfirmed accounts can't receive shares by an address they may not own (F15).
        emailVerifiedAt: { [Op.not]: null },
      },
    });

    if (!recipient) {
      throw Object.assign(
        new Error(`No confirmed account with email or username "${trimmed}"`),
        { status: 404 },
      );
    }

    if (recipient.id === ownerId) {
      throw Object.assign(new Error("You cannot share a note with yourself"), {
        status: 400,
      });
    }

    const linkedCollections = await CollectionService.collectionsByNoteId([note.id]);
    const companyId =
      (linkedCollections.get(note.id) || []).find((collection) => collection.companyId)
        ?.companyId ?? null;
    if (companyId) {
      const member = await CompanyMember.findOne({
        where: {
          companyId,
          userId: recipient.id,
          status: "active",
        },
      });
      if (!member) {
        throw Object.assign(
          new Error("Company notes can only be shared with people in this company"),
          { status: 400 }
        );
      }
    }

    if (permission !== "view" && permission !== "edit") {
      throw Object.assign(new Error("Permission must be view or edit"), {
        status: 400,
      });
    }

    let share = await NoteShare.findOne({
      where: { noteId, sharedWithUserId: recipient.id },
    });

    if (!companyId) {
      await this.assertPlanAllowsShares(ownerId, noteId, share ? 0 : 1, expiresAt, share?.expiresAt);
    }

    if (share) {
      await share.update({ permission, expiresAt });
    } else {
      share = await NoteShare.create({
        noteId,
        sharedByUserId: ownerId,
        sharedWithUserId: recipient.id,
        permission,
        expiresAt,
      });
    }

    const owner = await User.findByPk(ownerId, {
      attributes: ["username", "fullName"],
    });
    const ownerName = owner?.fullName || owner?.username || "Someone";
    await NotificationService.create(
      recipient.id,
      // The server can't read item titles: the notice doesn't name them.
      `${ownerName} shared an item with you`,
      note.id
    );
    await EmailService.sendNoteShare({
      to: recipient.email,
      noteTitle: "",
      companyId,
    });

    return NoteShare.findByPk(share.id, {
      include: [
        {
          model: User,
          as: "sharedWith",
          attributes: ["id", "username", "email", "fullName"],
        },
      ],
    });
  }

  /**
   * Share a note with multiple users at once (owner only)
   */
  /** Plan limits for sharing a personal note: people, and end dates. */
  private async assertPlanAllowsShares(
    ownerId: number,
    noteId: number,
    adding: number,
    expiresAt: Date | null,
    previousExpiry?: Date | null
  ) {
    const current = await NoteShare.count({
      where: {
        noteId,
        [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
      },
    });
    await EntitlementService.assertCanShareWith(ownerId, current, adding);
    const changedExpiry =
      !!expiresAt && (!previousExpiry || new Date(previousExpiry).getTime() !== expiresAt.getTime());
    if (changedExpiry) await EntitlementService.assertCanUseShareExpiry(ownerId);
  }

  async shareNoteWithMany(
    noteId: number,
    ownerId: number,
    identifiers: string[],
    permission: SharePermission = "view",
    expiresAt: Date | null = null,
    e2eKeys?: unknown,
  ) {
    // Manage check first: the end-to-end key step below must never run for
    // someone else's note (it would reveal which notes exist and who has them).
    const access = await this.getNoteAccess(noteId, ownerId);
    if (!access || !canManage(access, ownerId)) {
      throw Object.assign(new Error("Note not found or you are not the owner"), {
        status: 404,
      });
    }

    const uniqueIdentifiers = [
      ...new Set(
        identifiers.map((id) => id?.trim()).filter((id): id is string => !!id),
      ),
    ];

    // Plan limits (personal notes): checked once for the whole request.
    const inCompany = ((await CollectionService.collectionsByNoteId([noteId])).get(noteId) || []).some(
      (collection) => collection.companyId
    );
    if (!inCompany && uniqueIdentifiers.length) {
      const people = await User.findAll({
        where: { [Op.or]: [{ email: { [Op.in]: uniqueIdentifiers } }, { username: { [Op.in]: uniqueIdentifiers } }], emailVerifiedAt: { [Op.not]: null } },
        attributes: ["id"],
      });
      const already = await NoteShare.findAll({
        where: { noteId, sharedWithUserId: { [Op.in]: people.map((person) => person.id) } },
        attributes: ["sharedWithUserId"],
      });
      await this.assertPlanAllowsShares(ownerId, noteId, people.length - already.length, expiresAt);
    }
    // End-to-end items: a key copy for each person, made in the browser.
    // Before the per-person loop, which reports errors as failed people.
    const recipients = uniqueIdentifiers.length
      ? await User.findAll({
          where: { [Op.or]: [{ email: { [Op.in]: uniqueIdentifiers } }, { username: { [Op.in]: uniqueIdentifiers } }], emailVerifiedAt: { [Op.not]: null } },
          attributes: ["id"],
        })
      : [];
    await E2EItemService.ensure(ownerId, [noteId], e2eKeys, {
      extraShares: new Map([[noteId, recipients.map((user) => user.id)]]),
    });

    if (!uniqueIdentifiers.length) {
      throw Object.assign(
        new Error("At least one email or username is required"),
        { status: 400 },
      );
    }

    const shared: any[] = [];
    const failed: { identifier: string; message: string }[] = [];

    for (const identifier of uniqueIdentifiers) {
      try {
        const share = await this.shareNote(
          noteId,
          ownerId,
          identifier,
          permission,
          expiresAt,
        );
        shared.push(share);
      } catch (error: any) {
        failed.push({
          identifier,
          message: error.message || "Failed to share",
        });
      }
    }

    return { shared, failed };
  }

  /**
   * List shares for a note (owner only)
   */
  async getNoteShares(noteId: number, ownerId: number) {
    const access = await this.getNoteAccess(noteId, ownerId);
    if (!access || !canManage(access, ownerId)) {
      throw Object.assign(
        new Error("Note not found or you are not the owner"),
        {
          status: 404,
        },
      );
    }

    return NoteShare.findAll({
      where: { noteId },
      include: [
        {
          model: User,
          as: "sharedWith",
          attributes: ["id", "username", "email", "fullName"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });
  }

  /**
   * Revoke a share (owner only)
   */
  async revokeShare(noteId: number, ownerId: number, sharedWithUserId: number) {
    const access = await this.getNoteAccess(noteId, ownerId);
    if (!access || !canManage(access, ownerId)) {
      throw Object.assign(
        new Error("Note not found or you are not the owner"),
        {
          status: 404,
        },
      );
    }

    const deleted = await NoteShare.destroy({
      where: { noteId, sharedWithUserId },
    });
    await E2EItemService.dropItemKey(noteId, "user", sharedWithUserId);

    if (!deleted) {
      throw Object.assign(new Error("Share not found"), { status: 404 });
    }

    return true;
  }

  /**
   * Someone shared an item with you and you no longer want it: drop your own
   * share. If it also reaches you through a shared collection, those
   * collections are returned so you can leave them too.
   */
  async leaveShare(noteId: number, userId: number) {
    const note = await Note.findByPk(noteId, { attributes: ["id", "userId", "companyId", "title"] });
    if (!note) {
      throw Object.assign(new Error("Item not found"), { status: 404 });
    }
    if (note.userId === userId && note.companyId == null) {
      throw Object.assign(new Error("This is your own item. Move it to Trash instead."), {
        status: 400,
      });
    }

    const linked = (await CollectionService.collectionsByNoteId([noteId])).get(noteId) || [];
    if (isWorkItem(note, linked)) {
      throw Object.assign(
        new Error("Company items follow your access in the company. Ask a company admin."),
        { status: 400 }
      );
    }

    const removed = await NoteShare.destroy({
      where: { noteId, sharedWithUserId: userId },
    });
    await E2EItemService.dropItemKey(noteId, "user", userId);

    const viaCollections = linked.length
      ? await CollectionShare.findAll({
          where: this.activeShareFilter({
            sharedWithUserId: userId,
            collectionId: { [Op.in]: linked.map((collection) => collection.id) },
          }),
          attributes: ["collectionId"],
        })
      : [];
    const collections = linked
      .filter((collection) =>
        viaCollections.some((share) => share.collectionId === collection.id)
      )
      .map((collection) => ({ id: collection.id, name: collection.name }));

    if (!removed && !collections.length) {
      throw Object.assign(new Error("This item is not shared with you"), { status: 404 });
    }

    return {
      removed: removed > 0,
      collections,
      ownerId: note.userId,
    };
  }

  /**
   * Everyone who can open an item and how. For the item's owner, or company
   * owners/admins when it is a company item.
   */
  async getAccessList(noteId: number, userId: number) {
    const note = await Note.findByPk(noteId, {
      attributes: ["id", "userId", "companyId"],
      include: [{ model: User, as: "user", attributes: ["id", "username", "email", "fullName"] }],
    });
    if (!note) return null;
    const companyIds = [
      ...new Set(
        [note.companyId, ...((await CollectionService.collectionsByNoteId([noteId])).get(noteId) || []).map(
          (collection) => collection.companyId
        )].filter((id): id is number => !!id)
      ),
    ];
    const managed = await this.managedCompanyIds(userId);
    // Company items: only companies you manage, and only access through them.
    const scope = new Set(companyIds.filter((id) => managed.has(id)));
    const allowed = companyIds.length ? scope.size > 0 : note.userId === userId;
    if (!allowed) return null;
    const companyId = companyIds.length ? [...scope][0] : null;

    const people =
      (await AccessService.peopleByNote([noteId], managed)).get(noteId) || [];
    // A work item has no owner: it belongs to the company, not whoever made it.
    const owner = companyIds.length ? undefined : (note.get("user") as User | undefined);
    return {
      owner: owner
        ? { userId: owner.id, name: owner.fullName || owner.username, email: owner.email }
        : null,
      people,
      count: people.length,
      companyId,
    };
  }

  /** Active companies where you are owner or admin. */
  private async managedCompanyIds(userId: number) {
    const rows = await CompanyMember.findAll({
      where: { userId, status: "active", role: { [Op.in]: ["owner", "admin"] } },
      attributes: ["companyId"],
      include: [
        { model: Company, as: "company", attributes: [], where: { status: "active" } },
      ],
    });
    return new Set(rows.map((row) => row.companyId));
  }
}

export default new NoteService();
