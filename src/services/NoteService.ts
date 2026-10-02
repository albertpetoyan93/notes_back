import Note from "../models/Note";
import NoteShare, { SharePermission } from "../models/NoteShare";
import NoteFavorite from "../models/NoteFavorite";
import User from "../models/User";
import Collection from "../models/Collection";
import CollectionShare from "../models/CollectionShare";
import CompanyMember from "../models/CompanyMember";
import EmailService from "./EmailService";
import NotificationService from "./NotificationService";
import CollectionService from "./CollectionService";
import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";

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
  title: string;
  content: any;
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
  project?: string;
  tags?: string[];
  isFavorite?: boolean;
  isEncrypted?: boolean;
  collectionId?: number | null;
  collectionIds?: number[];
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
}

function storedCategory<T extends string | undefined>(category: T): T {
  return (category === "login" ? "password" : category) as T;
}

class NoteService {
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
        attributes: ["id", "name", "companyId"],
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
    const isOwner = note.userId === userId;
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
              name: json.collection.name,
              companyId: json.collection.companyId ?? null,
            },
          ]
        : [];
    json.collections = linked;
    json.collection = linked[0] || null;
    json.collectionId = linked[0]?.id ?? null;
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
      let companyCollections: { id: number }[] = [];
      try {
        companyCollections = await CollectionService.listForCompany(
          filters.companyId,
          userId
        );
      } catch (error: any) {
        if (error?.status === 404 || error?.status === 403) return [];
        throw error;
      }
      const ids = companyCollections.map((collection) => collection.id);
      const selected =
        filters.collectionId && ids.includes(filters.collectionId)
          ? [filters.collectionId]
          : filters.collectionId
            ? []
            : ids;
      const noteIds = await CollectionService.noteIdsForCollections(selected);
      whereClause = {
        id: { [Op.in]: noteIds.length ? noteIds : [-1] },
      };
    } else if (filters?.collectionId) {
      const access = await CollectionService.getAccess(
        filters.collectionId,
        userId
      );
      if (!access) return [];
      const noteIds = await CollectionService.noteIdsForCollections([
        filters.collectionId,
      ]);
      whereClause = {
        id: { [Op.in]: noteIds.length ? noteIds : [-1] },
      };
      if (filters?.trash) {
        whereClause.userId = userId;
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

    if (filters?.project && filters.project !== "all") {
      whereClause.project = filters.project;
    }

    const andClauses = [...(whereClause[Op.and] || [])];

    if (!filters?.companyId && !filters?.collectionId) {
      andClauses.push(
        sequelize.literal(`(
          NOT EXISTS (
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

    if (filters?.tag && filters.tag !== "all") {
      andClauses.push(
        sequelize.literal(
          `"tags"::jsonb @> ${sequelize.escape(JSON.stringify([filters.tag]))}::jsonb`
        )
      );
    }

    if (filters?.search) {
      const searchTerm = `%${filters.search}%`;
      andClauses.push({
        [Op.or]: [
          { title: { [Op.iLike]: searchTerm } },
          { project: { [Op.iLike]: searchTerm } },
          { "$collection.name$": { [Op.iLike]: searchTerm } },
          sequelize.where(sequelize.cast(sequelize.col("tags"), "text"), {
            [Op.iLike]: searchTerm,
          }),
          sequelize.where(sequelize.cast(sequelize.col("content"), "text"), {
            [Op.iLike]: searchTerm,
          }),
        ],
      });
    }

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
    const passwordHealthById = filters?.trash
      ? new Map<number, { weak: boolean; reused: boolean; stale: boolean }>()
      : await this.passwordHealthByNoteId(userId);

    return notes.map((note) => {
      const annotated = this.annotateNote(
        note,
        userId,
        permissionByNoteId,
        favoriteNoteIds,
        collectionsByNoteId.get(note.id)
      );
      const passwordHealth = passwordHealthById.get(note.id);
      return passwordHealth ? { ...annotated, passwordHealth } : annotated;
    });
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
    return this.annotateNote(
      access.note,
      userId,
      permissionByNoteId,
      favoriteNoteIds,
      collections.get(access.note.id)
    );
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
      const content = note.content as { decryptionFailed?: boolean };
      const linked = collectionsByNoteId.get(note.id) || [];
      if (linked.some((collection) => collection.companyId)) continue;
      if (content?.decryptionFailed) {
        skipped += 1;
        continue;
      }
      const names = linked.map(
        (collection) => collection.name
      );
      exported.push({
        title: note.title,
        content: note.content,
        category: note.category,
        project: names[0] || note.project || null,
        collection: names[0] || null,
        collections: names,
        tags: note.tags || [],
        isFavorite: favoriteNoteIds.has(note.id),
      });
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      skipped,
      notes: exported,
    };
  }

  /**
   * Create notes from a backup file. Shares are not copied.
   */
  async importNotes(userId: number, notes: any[]) {
    if (!Array.isArray(notes) || notes.length === 0) {
      throw Object.assign(new Error("Backup has no notes"), { status: 400 });
    }
    if (notes.length > 1000) {
      throw Object.assign(new Error("Backup is limited to 1000 notes"), {
        status: 400,
      });
    }

    const categories = [
      "note",
      "password",
      "login",
      "command",
      "ssh",
      "db",
      "address",
      "card",
      "other",
    ] as const;
    let imported = 0;
    const failed: { title: string; message: string }[] = [];

    for (const item of notes) {
      const title = String(item?.title || "").trim();
      try {
        if (!title) {
          throw new Error("Title is required");
        }
        if (!(categories as readonly string[]).includes(item?.category)) {
          throw new Error("Invalid category");
        }
        if (
          !item.content ||
          typeof item.content !== "object" ||
          item.content.decryptionFailed
        ) {
          throw new Error("Invalid content");
        }

        const tags = Array.isArray(item.tags)
          ? item.tags
              .map((tag: unknown) => String(tag).trim())
              .filter(Boolean)
              .slice(0, 20)
          : [];

        const collectionNames = (
          Array.isArray(item.collections) ? item.collections : [item.collection || item.project]
        )
          .map((name: unknown) => String(name || "").trim())
          .filter(Boolean);
        const collectionIds: number[] = [];
        for (const collectionName of collectionNames) {
          const [collection] = await Collection.findOrCreate({
            where: { userId, name: collectionName.slice(0, 100) },
            defaults: { userId, name: collectionName.slice(0, 100) },
          });
          collectionIds.push(collection.id);
        }

        await this.createNote(userId, {
          title: title.slice(0, 255),
          content: item.content,
          category: storedCategory(item.category),
          collectionIds,
          tags,
          isFavorite: Boolean(item.isFavorite),
        });
        imported += 1;
      } catch (error) {
        console.error("Error importing note:", error);
        failed.push({
          title: title || "Untitled",
          message: "Could not import this note",
        });
      }
    }

    return { imported, failed };
  }

  /**
   * Create a new note
   */
  async createNote(userId: number, data: CreateNoteData) {
    const requested = this.requestedCollectionIds(data);
    if (requested?.length) {
      for (const collectionId of requested) {
        await CollectionService.assertCanAdd(collectionId, userId);
      }
    }

    const note = await Note.create({
      title: data.title,
      content: data.content,
      category: storedCategory(data.category) || "note",
      project: data.project,
      collectionId: null,
      tags: data.tags || [],
      isEncrypted: data.isEncrypted || false,
      userId,
    });

    if (requested?.length) {
      await CollectionService.setNoteCollections(note.id, requested);
    }

    if (data.isFavorite) {
      await this.setUserFavorite(userId, note.id, true);
    }

    const saved = await Note.findByPk(note.id, {
      include: this.collectionInclude(),
    });
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const collections = await CollectionService.collectionsByNoteId([note.id]);
    return this.annotateNote(
      saved || note,
      userId,
      new Map(),
      favoriteNoteIds,
      collections.get(note.id)
    );
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
    const payload: any = {
      title: data.title !== undefined ? data.title : note.title,
      content: data.content !== undefined ? data.content : note.content,
      category:
        data.category !== undefined ? storedCategory(data.category) : storedCategory(note.category),
      tags: data.tags !== undefined ? data.tags : note.tags,
      isEncrypted:
        data.isEncrypted !== undefined ? data.isEncrypted : note.isEncrypted,
    };

    const requested = this.requestedCollectionIds(data);
    if (access.permission === "owner" && requested) {
      for (const collectionId of requested) {
        await CollectionService.assertCanAdd(collectionId, userId);
      }
    }

    await note.update(payload);
    if (access.permission === "owner" && requested) {
      await CollectionService.setNoteCollections(note.id, requested);
    }

    if (access.permission === "owner" && data.isFavorite !== undefined) {
      await this.setUserFavorite(userId, note.id, Boolean(data.isFavorite));
    }

    const saved = await Note.findByPk(note.id, {
      include: this.collectionInclude(),
    });
    const favoriteNoteIds = await this.getFavoriteNoteIds(userId);
    const collections = await CollectionService.collectionsByNoteId([note.id]);
    const permissionByNoteId = new Map<number, SharePermission>();
    if (access.permission !== "owner") {
      permissionByNoteId.set(noteId, access.permission);
    }
    return this.annotateNote(
      saved || note,
      userId,
      permissionByNoteId,
      favoriteNoteIds,
      collections.get(note.id)
    );
  }

  async autofill(userId: number, host: string, query = "") {
    const pageHost = this.normalizeHost(host);
    const q = query.trim().toLowerCase();
    if (!pageHost && q.length < 2) {
      throw Object.assign(new Error("Invalid site"), { status: 400 });
    }

    const noteIds = await this.autofillNoteIds(userId);
    const notes = noteIds.length
      ? await Note.findAll({
          where: {
            id: { [Op.in]: noteIds },
            category: { [Op.in]: ["password", "login"] },
          },
          attributes: ["id", "title", "content", "isEncrypted"],
        })
      : [];

    const matches: { id: number; title: string; username: string; password: string }[] =
      [];

    notes.forEach((note) => {
      const content = note.content as any;
      if (!content || content.decryptionFailed) return;
      const fields = Array.isArray(content.customFields) ? content.customFields : [];
      const matched = q
        ? this.noteMatchesQuery(note.title, fields, q)
        : this.noteMatchesHost(note.title, fields, pageHost);
      if (!matched) return;
      const password = this.pickPassword(fields);
      if (!password) return;
      matches.push({
        id: note.id,
        title: note.title,
        username: this.pickUsername(fields),
        password,
      });
    });

    return matches.slice(0, 20);
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
      attributes: ["id"],
    });
    const collectionsByNote = await CollectionService.collectionsByNoteId(
      personalCandidates.map((note) => note.id)
    );
    const personalIds = personalCandidates
      .filter((note) => {
        const linked = collectionsByNote.get(note.id) || [];
        return !linked.some((collection) => collection.companyId);
      })
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

  private normalizeHost(value: string) {
    const host = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return "";
    return host;
  }

  private rootHost(host: string) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
    const multi = ["co.uk", "com.au", "co.jp", "com.br", "co.nz", "com.tr", "co.za"];
    for (const suffix of multi) {
      if (host.endsWith(`.${suffix}`)) {
        const left = host.slice(0, -(suffix.length + 1));
        const brand = left.split(".").pop();
        return brand ? `${brand}.${suffix}` : host;
      }
    }
    const parts = host.split(".");
    return parts.length <= 2 ? host : parts.slice(-2).join(".");
  }

  private hostFromText(value: string) {
    const trimmed = String(value || "").trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.includes("@")) return "";
    try {
      const withProtocol = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
      const hostname = new URL(withProtocol).hostname;
      if (!hostname.includes(".")) return "";
      return this.normalizeHost(hostname);
    } catch {
      return "";
    }
  }

  private noteMatchesHost(title: string, fields: any[], pageHost: string) {
    const site = this.rootHost(pageHost);
    const texts = this.matchTexts(title, fields);
    if (texts.some((text) => this.nameMatchesHost(text, pageHost))) return true;

    const savedHosts = texts
      .map((text) => this.hostFromText(text))
      .filter((host) => host);
    return savedHosts.some((host) => this.rootHost(host) === site);
  }

  private noteMatchesQuery(title: string, fields: any[], query: string) {
    return this.matchTexts(title, fields).some((text) =>
      text.toLowerCase().includes(query)
    );
  }

  private matchTexts(title: string, fields: any[]) {
    return [
      title,
      ...fields
        .filter(
          (field) =>
            field?.value &&
            !(typeof field.label === "string" && /pass/i.test(field.label))
        )
        .map((field) => String(field.value)),
    ];
  }

  private nameMatchesHost(value: string, pageHost: string) {
    const labels = pageHost.toLowerCase().split(".");
    const ignored = new Set(["www", "com", "net", "org", "io", "app", "ru", "co"]);
    return value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2 && !ignored.has(token))
      .some(
        (token) =>
          labels.includes(token) ||
          (token.length >= 4 && labels.some((label) => label.includes(token)))
      );
  }

  private pickPassword(fields: any[]) {
    const labeled = fields.filter(
      (field) => field?.value && typeof field.label === "string" && /pass/i.test(field.label)
    );
    const preferred = labeled.find(
      (field) => /password/i.test(field.label) && !/key/i.test(field.label)
    );
    return String((preferred || labeled[0])?.value || "");
  }

  private pickUsername(fields: any[]) {
    const field = fields.find(
      (item) =>
        item?.value &&
        typeof item.label === "string" &&
        /user|email|login/i.test(item.label) &&
        !/pass/i.test(item.label)
    );
    return field ? String(field.value) : "";
  }

  private passwordValues(content: any): string[] {
    if (!content || content.decryptionFailed) return [];
    const fields = Array.isArray(content.customFields) ? content.customFields : [];
    return fields
      .filter(
        (field: any) =>
          typeof field?.label === "string" &&
          /pass/i.test(field.label) &&
          field.value
      )
      .map((field: any) => String(field.value));
  }

  private isWeakPassword(value: string) {
    if (value.length < 12) return true;
    let classes = 0;
    if (/[a-z]/.test(value)) classes += 1;
    if (/[A-Z]/.test(value)) classes += 1;
    if (/[0-9]/.test(value)) classes += 1;
    if (/[^A-Za-z0-9]/.test(value)) classes += 1;
    return classes < 3;
  }

  private async passwordHealthByNoteId(userId: number) {
    const notes = await Note.findAll({
      where: { userId, category: { [Op.in]: ["password", "login"] } },
      attributes: ["id", "content", "updatedAt", "category", "isEncrypted"],
    });
    const collectionsByNote = await CollectionService.collectionsByNoteId(
      notes.map((note) => note.id)
    );
    const personalNotes = notes.filter((note) => {
      const linked = collectionsByNote.get(note.id) || [];
      return !linked.some((collection) => collection.companyId);
    });

    const noteIdsBySecret = new Map<string, Set<number>>();
    const valuesByNote = new Map<number, string[]>();
    personalNotes.forEach((note) => {
      const values = this.passwordValues(note.content);
      valuesByNote.set(note.id, values);
      new Set(values).forEach((value) => {
        const ids = noteIdsBySecret.get(value) || new Set<number>();
        ids.add(note.id);
        noteIdsBySecret.set(value, ids);
      });
    });

    const staleBefore = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const health = new Map<
      number,
      { weak: boolean; reused: boolean; stale: boolean }
    >();

    personalNotes.forEach((note) => {
      const values = valuesByNote.get(note.id) || [];
      if (!values.length) return;
      const weak = values.some((value) => this.isWeakPassword(value));
      const reused = values.some(
        (value) => (noteIdsBySecret.get(value)?.size || 0) > 1
      );
      const stale = new Date(note.updatedAt).getTime() < staleBefore;
      if (weak || reused || stale) {
        health.set(note.id, { weak, reused, stale });
      }
    });

    return health;
  }

  async purgeOldTrash(userId: number) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await sequelize.query(
      `DELETE FROM "notes"
       WHERE "userId" = :userId
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
    collectionId?: number | null
  ) {
    const ids = [...new Set(noteIds.map(Number).filter((id) => !isNaN(id)))];
    if (!ids.length) {
      throw Object.assign(new Error("Choose at least one note"), { status: 400 });
    }

    const notes = await Note.findAll({
      where: { id: { [Op.in]: ids }, userId },
    });
    if (!notes.length) {
      throw Object.assign(new Error("You can only change notes you own"), {
        status: 400,
      });
    }

    const collectionsByNote = await CollectionService.collectionsByNoteId(
      notes.map((note) => note.id)
    );
    const openCollections = await CollectionService.openCompanyCollections(userId);
    const editable = notes.filter((note) => {
      const companyCollections = (collectionsByNote.get(note.id) || []).filter(
        (collection) => collection.companyId
      );
      if (!companyCollections.length) return true;
      return companyCollections.some((collection) => openCollections.has(collection.id));
    });
    if (!editable.length) {
      throw Object.assign(new Error("You can only change notes you own"), {
        status: 400,
      });
    }

    if (action === "trash") {
      for (const note of editable) {
        await note.destroy();
      }
      return { updated: editable.length, skipped: ids.length - editable.length };
    }

    const nextIds: number[] = [];
    if (collectionId) {
      const access = await CollectionService.assertCanAdd(collectionId, userId);
      nextIds.push(access.collection.id);
    }

    for (const note of editable) {
      await CollectionService.setNoteCollections(note.id, nextIds);
    }

    return { updated: editable.length, skipped: ids.length - editable.length };
  }

  /**
   * Delete a note (owner only)
   */
  async deleteNote(noteId: number, userId: number) {
    const access = await this.getNoteAccess(noteId, userId);
    if (!access || access.permission !== "owner") {
      return false;
    }

    await access.note.destroy();
    return true;
  }

  /**
   * Restore a soft-deleted note (owner only)
   */
  async restoreNote(noteId: number, userId: number) {
    const note = await Note.findOne({
      where: { id: noteId, userId },
      paranoid: false,
    });

    if (!note || !note.deletedAt) {
      return false;
    }

    const linked = await CollectionService.collectionsByNoteId([note.id]);
    const companyCollections = (linked.get(note.id) || []).filter(
      (collection) => collection.companyId
    );
    if (companyCollections.length) {
      const open = await CollectionService.openCompanyCollections(userId);
      if (!companyCollections.some((collection) => open.has(collection.id))) {
        return false;
      }
    }

    await note.restore();
    return true;
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
    return this.annotateNote(
      access.note,
      userId,
      permissionByNoteId,
      favoriteNoteIds,
      collections.get(noteId)
    );
  }

  /**
   * Get all distinct projects for a user (owned + shared notes)
   */
  async getProjects(userId: number) {
    const { sharedNoteIds } = await this.getSharedNoteIds(userId);

    const projects = await Note.findAll({
      where: {
        [Op.or]: [
          { userId },
          ...(sharedNoteIds.length ? [{ id: { [Op.in]: sharedNoteIds } }] : []),
        ],
        project: { [Op.not]: null as any },
      },
      attributes: [
        [sequelize.fn("DISTINCT", sequelize.col("project")), "project"],
      ],
      raw: true,
    });

    return projects.map((p: any) => p.project).filter(Boolean);
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
    if (companyCollections.length) {
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
    let permission: SharePermission | null = null;
    for (const collection of companyCollections) {
      const fromOpen = open.get(collection.id);
      if (!fromOpen) continue;
      const fromCollection = fromOpen === "owner" ? "edit" : fromOpen;
      if (!permission || (permission === "view" && fromCollection === "edit")) {
        permission = fromCollection;
      }
    }

    const share = await NoteShare.findOne({
      where: this.activeShareFilter({ noteId: note.id, sharedWithUserId: userId }),
    });
    if (share) {
      const activeCompanies = await CollectionService.activeCompanyIds(userId);
      const inActiveCompany = companyCollections.some(
        (collection) => collection.companyId && activeCompanies.has(collection.companyId)
      );
      if (
        inActiveCompany &&
        (!permission || (permission === "view" && share.permission === "edit"))
      ) {
        permission = share.permission;
      }
    }

    if (!permission) return null;
    if (note.userId === userId) return { note, permission: "owner" as const };
    return { note, permission };
  }

  /**
   * Share a note with another user by email or username (owner only)
   */
  async shareNote(
    noteId: number,
    ownerId: number,
    identifier: string,
    permission: SharePermission = "view",
    expiresAt: Date | null = null,
  ) {
    const access = await this.getNoteAccess(noteId, ownerId);
    if (!access || access.permission !== "owner") {
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
      },
    });

    if (!recipient) {
      throw Object.assign(
        new Error(`No user found with email or username "${trimmed}"`),
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
      `${ownerName} shared "${note.title}" with you`,
      note.id
    );
    await EmailService.sendNoteShare({
      to: recipient.email,
      noteTitle: note.title,
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
  async shareNoteWithMany(
    noteId: number,
    ownerId: number,
    identifiers: string[],
    permission: SharePermission = "view",
    expiresAt: Date | null = null,
  ) {
    const uniqueIdentifiers = [
      ...new Set(
        identifiers.map((id) => id?.trim()).filter((id): id is string => !!id),
      ),
    ];

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
    if (!access || access.permission !== "owner") {
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
    if (!access || access.permission !== "owner") {
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

    if (!deleted) {
      throw Object.assign(new Error("Share not found"), { status: 404 });
    }

    return true;
  }
}

export default new NoteService();
