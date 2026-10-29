import { Op } from "sequelize";
import EntitlementService from "./EntitlementService";
import CompanyPolicyService from "./CompanyPolicyService";
import Collection from "../models/Collection";
import CollectionNote from "../models/CollectionNote";
import CollectionShare from "../models/CollectionShare";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import Note from "../models/Note";
import User from "../models/User";
import { SharePermission } from "../models/NoteShare";
import NotificationService from "./NotificationService";
import E2EItemService, { collectionLabel, nameFields, placeholderName, assertEncName } from "./E2EItemService";
import CollectionKey from "../models/CollectionKey";

class CollectionService {
  private activeShareFilter(where: Record<string, unknown>) {
    return {
      ...where,
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
    };
  }

  async getAccess(collectionId: number, userId: number) {
    const collection = await Collection.findByPk(collectionId);
    if (!collection) return null;
    if (collection.companyId) {
      const company = await Company.findByPk(collection.companyId);
      if (!company || company.status !== "active") return null;
      // The company requires 2FA and this person doesn't use it.
      if ((await CompanyPolicyService.forUser(userId)).blocked.has(company.id)) return null;
      const member = await CompanyMember.findOne({
        where: {
          companyId: collection.companyId,
          userId,
          status: "active",
        },
      });
      if (!member) return null;
      if (member.role !== "member") {
        return { collection, permission: "owner" as const };
      }
      const share = await CollectionShare.findOne({
        where: this.activeShareFilter({ collectionId, sharedWithUserId: userId }),
      });
      const permission = this.memberPermission(collection.companyShare, share?.permission);
      if (!permission) return null;
      return { collection, permission };
    }
    if (collection.userId === userId) {
      return { collection, permission: "owner" as const };
    }

    const share = await CollectionShare.findOne({
      where: this.activeShareFilter({
        collectionId,
        sharedWithUserId: userId,
      }),
    });
    if (!share) return null;
    return { collection, permission: share.permission };
  }

  async list(userId: number) {
    const shares = await CollectionShare.findAll({
      where: this.activeShareFilter({ sharedWithUserId: userId }),
      attributes: ["collectionId", "permission"],
    });
    const permissionById = new Map<number, SharePermission>(
      shares.map((share) => [share.collectionId, share.permission])
    );

    const collections = await Collection.findAll({
      where: {
        companyId: { [Op.is]: null },
        [Op.or]: [
          { userId },
          ...(permissionById.size
            ? [{ id: { [Op.in]: [...permissionById.keys()] } }]
            : []),
        ],
      },
      order: [["name", "ASC"]],
    });

    const ids = collections.map((collection) => collection.id);
    const countById = await this.noteCounts(ids);
    const myKeys = await this.myCollectionKeys(userId, ids);

    return collections.map((collection) => ({
      id: collection.id,
      // Encrypted names come with the caller's way to open them.
      ...nameFields(collection, myKeys.get(collection.id)),
      isOwner: collection.userId === userId,
      permission:
        collection.userId === userId
          ? "owner"
          : permissionById.get(collection.id) || "view",
      noteCount: countById.get(collection.id) || 0,
    }));
  }

  /** The caller's copies of these collections' keys (for opening encrypted names). */
  private async myCollectionKeys(userId: number, ids: number[]) {
    const rows = ids.length
      ? await CollectionKey.findAll({ where: { userId, collectionId: { [Op.in]: ids } } })
      : [];
    return new Map(rows.map((row) => [row.collectionId, row]));
  }

  /**
   * A name sent encrypted with the owner's user key (end-to-end accounts):
   * the server stores it as it is, behind a placeholder. It can't check for a
   * duplicate; the app does, among the names it can open.
   */
  private encryptedName(enc: any, allowed = "user") {
    if (!enc?.encName) return null;
    if (enc.nameKey !== allowed) throw Object.assign(new Error("Reload the page, then try again."), { status: 409 });
    return { name: placeholderName(), encName: assertEncName(enc.encName), nameKey: allowed };
  }

  async create(userId: number, name: string, enc?: unknown) {
    const sealed = this.encryptedName(enc);
    const trimmed = sealed ? sealed.name : name.trim();
    if (!trimmed) {
      throw Object.assign(new Error("Collection name is required"), {
        status: 400,
      });
    }

    const existing = await Collection.findOne({
      where: { userId, name: trimmed, companyId: { [Op.is]: null } },
    });
    // Free plan: a few collections. Existing ones always keep working.
    const owned = await Collection.count({ where: { userId, companyId: { [Op.is]: null } } });
    await EntitlementService.assertCanCreateCollection(userId, owned);
    if (existing) {
      throw Object.assign(
        new Error(`You already have a collection named "${trimmed}"`),
        { status: 400 }
      );
    }

    const collection = await Collection.create({
      userId,
      name: trimmed.slice(0, 100),
      companyId: null,
      ...(sealed ? { encName: sealed.encName, nameKey: sealed.nameKey } : {}),
    });
    return {
      id: collection.id,
      ...nameFields(collection),
      isOwner: true,
      permission: "owner" as const,
      noteCount: 0,
    };
  }

  async listForCompany(companyId: number, userId: number) {
    const access = await this.companyMember(companyId, userId);
    if (!access) {
      throw Object.assign(new Error("Company not found"), { status: 404 });
    }
    // Required 2FA missing: nothing of the company opens, names included.
    if ((await CompanyPolicyService.forUser(userId)).blocked.has(companyId)) return [];
    const collections = await Collection.findAll({
      where: { companyId },
      order: [["name", "ASC"]],
    });
    const ids = collections.map((collection) => collection.id);
    const shareRows = ids.length
      ? await CollectionShare.findAll({
          where: this.activeShareFilter({
            collectionId: { [Op.in]: ids },
            ...(access.role === "member" ? { sharedWithUserId: userId } : {}),
          }),
          include:
            access.role === "member"
              ? []
              : [
                  {
                    model: User,
                    as: "sharedWith",
                    attributes: ["id", "email", "fullName", "username"],
                  },
                ],
        })
      : [];
    const directByCollection = new Map<number, SharePermission>();
    const peopleByCollection = new Map<
      number,
      { userId: number; email: string; name: string; permission: SharePermission }[]
    >();
    for (const share of shareRows) {
      if (access.role === "member") {
        const current = directByCollection.get(share.collectionId);
        if (current !== "edit") directByCollection.set(share.collectionId, share.permission);
        continue;
      }
      const person = share.get("sharedWith") as User | undefined;
      const list = peopleByCollection.get(share.collectionId) || [];
      list.push({
        userId: share.sharedWithUserId,
        email: person?.email || "",
        name: person?.fullName || person?.username || person?.email || "",
        permission: share.permission,
      });
      peopleByCollection.set(share.collectionId, list);
    }
    const countById = await this.noteCounts(ids);
    const myKeys = await this.myCollectionKeys(userId, ids);
    const visible =
      access.role === "member"
        ? collections.filter(
            (collection) =>
              collection.companyShare === "view" ||
              collection.companyShare === "edit" ||
              directByCollection.has(collection.id)
          )
        : collections;
    return visible.map((collection) => {
      const companyShare =
        collection.companyShare === "view" || collection.companyShare === "edit"
          ? collection.companyShare
          : null;
      const permission =
        access.role === "member"
          ? this.memberPermission(companyShare, directByCollection.get(collection.id)) || "view"
          : ("owner" as const);
      return {
        id: collection.id,
        ...nameFields(collection, myKeys.get(collection.id)),
        noteCount: countById.get(collection.id) || 0,
        permission,
        companyShare,
        shares: access.role === "member" ? [] : peopleByCollection.get(collection.id) || [],
      };
    });
  }

  async shareCompanyCollection(
    companyId: number,
    collectionId: number,
    userId: number,
    audience: string,
    permission: string,
    emails: string[] = []
  ) {
    const manager = await this.companyMember(companyId, userId);
    if (!manager || manager.role === "member") {
      throw Object.assign(new Error("You cannot share collections here"), { status: 403 });
    }
    const collection = await Collection.findOne({ where: { id: collectionId, companyId } });
    if (!collection) {
      throw Object.assign(new Error("Collection not found"), { status: 404 });
    }
    const nextPermission: SharePermission = permission === "edit" ? "edit" : "view";
    if (audience === "all") {
      await collection.update({ companyShare: nextPermission });
      return { shared: [], failed: [] as { email: string; message: string }[] };
    }
    const list = [...new Set(emails.map((item) => item.trim().toLowerCase()).filter(Boolean))];
    if (!list.length) {
      throw Object.assign(new Error("Choose at least one person"), { status: 400 });
    }
    const shared: { email: string }[] = [];
    const failed: { email: string; message: string }[] = [];
    for (const normalized of list) {
      try {
        const recipient = await User.findOne({
          where: { email: { [Op.iLike]: normalized } },
          attributes: ["id", "email"],
        });
        if (!recipient) {
          throw Object.assign(new Error("That person is not in this company"), { status: 400 });
        }
        const member = await CompanyMember.findOne({
          where: { companyId, userId: recipient.id, status: "active" },
        });
        if (!member) {
          throw Object.assign(new Error("That person is not in this company"), { status: 400 });
        }
        const existing = await CollectionShare.findOne({
          where: { collectionId, sharedWithUserId: recipient.id },
        });
        if (existing) {
          await existing.update({
            permission: nextPermission,
            expiresAt: null,
            sharedByUserId: userId,
          });
        } else {
          await CollectionShare.create({
            collectionId,
            sharedByUserId: userId,
            sharedWithUserId: recipient.id,
            permission: nextPermission,
            expiresAt: null,
          });
        }
        shared.push({ email: recipient.email });
      } catch (error: any) {
        failed.push({
          email: normalized,
          message: error?.message || "Could not share",
        });
      }
    }
    return { shared, failed };
  }

  async unshareCompanyCollection(
    companyId: number,
    collectionId: number,
    userId: number,
    target: { all?: boolean; memberUserId?: number }
  ) {
    const manager = await this.companyMember(companyId, userId);
    if (!manager || manager.role === "member") {
      throw Object.assign(new Error("You cannot share collections here"), { status: 403 });
    }
    const collection = await Collection.findOne({ where: { id: collectionId, companyId } });
    if (!collection) {
      throw Object.assign(new Error("Collection not found"), { status: 404 });
    }
    if (target.all) {
      await collection.update({ companyShare: null });
      return { companyShare: null };
    }
    if (!target.memberUserId) {
      throw Object.assign(new Error("Choose a person to remove"), { status: 400 });
    }
    await CollectionShare.destroy({
      where: { collectionId, sharedWithUserId: target.memberUserId },
    });
    return { removed: target.memberUserId };
  }

  async createForCompany(companyId: number, userId: number, name: string) {
    const access = await this.companyMember(companyId, userId);
    if (!access || access.role === "member") {
      throw Object.assign(new Error("You cannot create collections here"), { status: 403 });
    }
    const trimmed = name.trim().replace(/\s+/g, " ").slice(0, 100);
    if (!trimmed) {
      throw Object.assign(new Error("Collection name is required"), { status: 400 });
    }
    const existing = await Collection.findOne({ where: { companyId, name: trimmed } });
    if (existing) {
      throw Object.assign(new Error(`This company already has a collection named "${trimmed}"`), {
        status: 400,
      });
    }
    const collection = await Collection.create({
      userId,
      companyId,
      name: trimmed,
    });
    return { id: collection.id, name: collection.name, noteCount: 0, permission: "owner" as const };
  }

  private memberPermission(
    companyShare?: string | null,
    direct?: SharePermission | null
  ): SharePermission | null {
    const allowed = (value?: string | null): SharePermission | null =>
      value === "edit" || value === "view" ? value : null;
    const everyone = allowed(companyShare);
    const person = allowed(direct);
    if (everyone === "edit" || person === "edit") return "edit";
    if (everyone || person) return "view";
    return null;
  }

  async activeCompanyIds(userId: number) {
    const memberships = await CompanyMember.findAll({
      where: { userId, status: "active" },
      attributes: ["companyId"],
    });
    const ids = memberships.map((member) => member.companyId);
    if (!ids.length) return new Set<number>();
    const companies = await Company.findAll({
      where: { id: { [Op.in]: ids }, status: "active" },
      attributes: ["id"],
    });
    const { blocked } = await CompanyPolicyService.forUser(userId);
    return new Set(companies.map((company) => company.id).filter((id) => !blocked.has(id)));
  }

  /** Collections this user can open in an active company while their membership is active. */
  async openCompanyCollections(userId: number) {
    const memberships = await CompanyMember.findAll({
      where: { userId, status: "active" },
      attributes: ["companyId", "role"],
    });
    const result = new Map<number, "owner" | SharePermission>();
    if (!memberships.length) return result;

    const companies = await Company.findAll({
      where: {
        id: { [Op.in]: memberships.map((member) => member.companyId) },
        status: "active",
      },
      attributes: ["id"],
    });
    const activeIds = new Set(companies.map((company) => company.id));
    // Companies that require 2FA from someone who doesn't use it stay closed.
    const { blocked } = await CompanyPolicyService.forUser(userId);

    for (const member of memberships) {
      if (!activeIds.has(member.companyId) || blocked.has(member.companyId)) continue;
      const collections = await Collection.findAll({
        where: { companyId: member.companyId },
        attributes: ["id", "companyShare"],
      });
      if (!collections.length) continue;
      if (member.role !== "member") {
        collections.forEach((collection) => result.set(collection.id, "owner"));
        continue;
      }
      const shares = await CollectionShare.findAll({
        where: this.activeShareFilter({
          collectionId: { [Op.in]: collections.map((collection) => collection.id) },
          sharedWithUserId: userId,
        }),
        attributes: ["collectionId", "permission"],
      });
      const direct = new Map(
        shares.map((share) => [share.collectionId, share.permission])
      );
      for (const collection of collections) {
        const permission = this.memberPermission(
          collection.companyShare,
          direct.get(collection.id)
        );
        if (permission) result.set(collection.id, permission);
      }
    }
    return result;
  }

  private async companyMember(companyId: number, userId: number) {
    const company = await Company.findByPk(companyId);
    if (!company || company.status !== "active") return null;
    return CompanyMember.findOne({
      where: { companyId, userId, status: "active" },
    });
  }

  async rename(collectionId: number, userId: number, name: string, enc?: unknown) {
    const access = await this.getAccess(collectionId, userId);
    if (!access || access.permission !== "owner") return null;

    // An encrypted name stays encrypted the same way (user key, or the current collection key).
    const sealed = access.collection.nameKey ? this.encryptedName(enc, access.collection.nameKey) : null;
    if (sealed) {
      await access.collection.update({ encName: sealed.encName });
      return { ...access.collection.toJSON(), ...nameFields(access.collection) };
    }
    if (access.collection.encName) {
      throw Object.assign(new Error("Reload the page, then rename the collection."), { status: 409 });
    }

    const trimmed = name.trim();
    if (!trimmed) {
      throw Object.assign(new Error("Collection name is required"), {
        status: 400,
      });
    }

    const duplicate = await Collection.findOne({
      where: {
        name: trimmed.slice(0, 100),
        id: { [Op.ne]: collectionId },
        ...(access.collection.companyId
          ? { companyId: access.collection.companyId }
          : { userId, companyId: { [Op.is]: null } }),
      },
    });
    if (duplicate) {
      throw Object.assign(
        new Error(`You already have a collection named "${trimmed}"`),
        { status: 400 }
      );
    }

    await access.collection.update({ name: trimmed.slice(0, 100) });
    await Note.update(
      { project: trimmed.slice(0, 100) },
      { where: { collectionId } }
    );
    return access.collection;
  }

  async remove(collectionId: number, userId: number) {
    const access = await this.getAccess(collectionId, userId);
    if (!access || access.permission !== "owner") return false;
    const links = await CollectionNote.findAll({
      where: { collectionId },
      attributes: ["noteId"],
    });
    const noteIds = links.map((link) => link.noteId);
    await CollectionNote.destroy({ where: { collectionId } });
    await Note.update(
      { collectionId: null, project: null },
      { where: { collectionId } }
    );
    for (const noteId of noteIds) {
      await this.restorePrimaryCollection(noteId);
    }
    await E2EItemService.dropCollection(collectionId);
    await access.collection.destroy();
    return true;
  }

  async assertCanAdd(collectionId: number, userId: number) {
    const access = await this.getAccess(collectionId, userId);
    if (
      !access ||
      (access.permission !== "owner" && access.permission !== "edit")
    ) {
      throw Object.assign(
        new Error("You cannot add notes to this collection"),
        { status: 403 }
      );
    }
    return access;
  }

  async addNotes(collectionId: number, userId: number, noteIds: number[], e2eKeys?: unknown) {
    const access = await this.assertCanAdd(collectionId, userId);
    const ids = [...new Set(noteIds.map(Number).filter((id) => !isNaN(id)))];
    if (!ids.length) {
      throw Object.assign(new Error("Choose at least one note"), {
        status: 400,
      });
    }

    const notes = await Note.findAll({
      where: { id: { [Op.in]: ids }, userId },
    });
    if (!notes.length) {
      throw Object.assign(new Error("You can only add notes you own"), {
        status: 400,
      });
    }
    // End-to-end items need a key copy for this collection (made in the browser).
    const current = await this.collectionsByNoteId(notes.map((note) => note.id));
    await E2EItemService.ensure(userId, notes.map((note) => note.id), e2eKeys, {
      collectionsByNote: new Map(
        notes.map((note) => [note.id, [...(current.get(note.id) || []).map((item) => item.id), collectionId]])
      ),
    });

    for (const note of notes) {
      await this.addNoteToCollection(note.id, collectionId, collectionLabel(access.collection));
    }

    return { added: notes.length, skipped: ids.length - notes.length };
  }

  async removeNote(collectionId: number, userId: number, noteId: number) {
    const access = await this.getAccess(collectionId, userId);
    const note = await Note.findByPk(noteId);
    const linked = await CollectionNote.findOne({
      where: { collectionId, noteId },
    });
    const inCollection = Boolean(linked) || note?.collectionId === collectionId;
    if (!note || !access || !inCollection) return false;

    const canRemove =
      access.permission === "owner" || note.userId === userId;
    if (!canRemove) return false;

    await CollectionNote.destroy({ where: { collectionId, noteId } });
    await E2EItemService.dropItemKey(noteId, "collection", collectionId);
    if (note.collectionId === collectionId) {
      await note.update({ collectionId: null, project: null });
      await this.restorePrimaryCollection(noteId);
    }
    return true;
  }

  async availableNotes(collectionId: number, userId: number) {
    await this.assertCanAdd(collectionId, userId);
    const linkedIds = await this.noteIdsForCollections([collectionId]);
    const notes = await Note.findAll({
      where: {
        userId,
        ...(linkedIds.length ? { id: { [Op.notIn]: linkedIds } } : {}),
      },
      // End-to-end items have no readable title: the browser opens encData.
      attributes: ["id", "title", "collectionId", "e2e", "e2eId", "itemKey", "encData"],
      order: [["title", "ASC"]],
    });
    return notes;
  }

  async noteIdsForCollections(collectionIds: number[]) {
    const links = await this.linksForCollections(collectionIds);
    return [...new Set(links.map((link) => link.noteId))];
  }

  async linksForCollections(collectionIds: number[]) {
    const ids = [...new Set(collectionIds.filter((id) => Number.isInteger(id)))];
    if (!ids.length) return [] as { noteId: number; collectionId: number }[];
    const links = await CollectionNote.findAll({
      where: { collectionId: { [Op.in]: ids } },
      attributes: ["noteId", "collectionId"],
    });
    const legacy = await Note.findAll({
      where: { collectionId: { [Op.in]: ids } },
      attributes: ["id", "collectionId"],
    });
    const seen = new Set(links.map((link) => `${link.collectionId}:${link.noteId}`));
    const rows = links.map((link) => ({
      noteId: link.noteId,
      collectionId: link.collectionId,
    }));
    for (const note of legacy) {
      if (!note.collectionId) continue;
      const key = `${note.collectionId}:${note.id}`;
      if (seen.has(key)) continue;
      rows.push({ noteId: note.id, collectionId: note.collectionId });
    }
    return rows;
  }

  async collectionsByNoteId(noteIds: number[]) {
    const ids = [...new Set(noteIds.filter((id) => Number.isInteger(id)))];
    const map = new Map<
      number,
      { id: number; name: string; companyId: number | null }[]
    >();
    if (!ids.length) return map;

    const links = await CollectionNote.findAll({
      where: { noteId: { [Op.in]: ids } },
      include: [
        {
          model: Collection,
          as: "collection",
          attributes: ["id", "name", "encName", "companyId"],
        },
      ],
    });
    for (const link of links) {
      const collection = link.get("collection") as Collection | undefined;
      if (!collection) continue;
      const list = map.get(link.noteId) || [];
      if (!list.some((item) => item.id === collection.id)) {
        list.push({
          id: collection.id,
          name: collectionLabel(collection),
          companyId: collection.companyId ?? null,
        });
      }
      map.set(link.noteId, list);
    }

    const missing = ids.filter((id) => !map.has(id));
    if (missing.length) {
      const notes = await Note.findAll({
        where: { id: { [Op.in]: missing }, collectionId: { [Op.not]: null } },
        include: [
          {
            model: Collection,
            as: "collection",
            attributes: ["id", "name", "encName", "companyId"],
          },
        ],
      });
      for (const note of notes) {
        const collection = (note as Note & { collection?: Collection }).collection;
        if (!collection || !note.collectionId) continue;
        map.set(note.id, [
          {
            id: collection.id,
            name: collectionLabel(collection),
            companyId: collection.companyId ?? null,
          },
        ]);
      }
    }
    return map;
  }

  async setNoteCollections(noteId: number, collectionIds: number[]) {
    const ids = [...new Set(collectionIds.filter((id) => Number.isInteger(id)))];
    // Key copies for collections the item leaves go with it.
    const left = await CollectionNote.findAll({
      where: { noteId, ...(ids.length ? { collectionId: { [Op.notIn]: ids } } : {}) },
      attributes: ["collectionId"],
    });
    for (const link of left) await E2EItemService.dropItemKey(noteId, "collection", link.collectionId);
    await CollectionNote.destroy({ where: { noteId } });
    if (ids.length) {
      await CollectionNote.bulkCreate(
        ids.map((collectionId) => ({ collectionId, noteId }))
      );
    }
    await Note.update(
      { collectionId: null, project: null },
      { where: { id: noteId } }
    );
    await this.restorePrimaryCollection(noteId);
  }

  async addNoteToCollection(noteId: number, collectionId: number, name: string) {
    await CollectionNote.findOrCreate({
      where: { noteId, collectionId },
      defaults: { noteId, collectionId },
    });
    const note = await Note.findByPk(noteId);
    if (note && !note.collectionId) {
      // An encrypted name isn't copied onto the item.
      await note.update({ collectionId, project: name || null });
    }
  }

  async listShares(collectionId: number, userId: number) {
    const access = await this.getAccess(collectionId, userId);
    if (!access || access.permission !== "owner") return null;
    return CollectionShare.findAll({
      where: { collectionId },
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

  async share(
    collectionId: number,
    ownerId: number,
    identifier: string,
    permission: SharePermission = "view",
    expiresAt: Date | null = null
  ) {
    const collection = await Collection.findOne({
      where: { id: collectionId, userId: ownerId },
    });
    if (!collection) {
      throw Object.assign(
        new Error("Collection not found or you are not the owner"),
        { status: 404 }
      );
    }

    const trimmed = identifier.trim();
    if (!trimmed) {
      throw Object.assign(new Error("Email or username is required"), {
        status: 400,
      });
    }

    const recipient = await User.findOne({
      where: { [Op.or]: [{ email: trimmed }, { username: trimmed }] },
    });
    if (!recipient) {
      throw Object.assign(
        new Error(`No user found with email or username "${trimmed}"`),
        { status: 404 }
      );
    }
    if (recipient.id === ownerId) {
      throw Object.assign(
        new Error("You cannot share a collection with yourself"),
        { status: 400 }
      );
    }
    if (collection.companyId) {
      const member = await CompanyMember.findOne({
        where: {
          companyId: collection.companyId,
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

    let share = await CollectionShare.findOne({
      where: { collectionId, sharedWithUserId: recipient.id },
    });
    if (!collection.companyId) {
      await this.assertPlanAllowsShares(ownerId, collectionId, share ? 0 : 1, expiresAt, share?.expiresAt);
    }
    if (share) {
      await share.update({ permission, expiresAt });
    } else {
      share = await CollectionShare.create({
        collectionId,
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
      collectionLabel(collection)
        ? `${ownerName} shared the collection "${collectionLabel(collection)}" with you`
        : `${ownerName} shared a collection with you`
    );

    return CollectionShare.findByPk(share.id, {
      include: [
        {
          model: User,
          as: "sharedWith",
          attributes: ["id", "username", "email", "fullName"],
        },
      ],
    });
  }

  /** Plan limits for sharing a personal collection: people, and end dates. */
  private async assertPlanAllowsShares(
    ownerId: number,
    collectionId: number,
    adding: number,
    expiresAt: Date | null,
    previousExpiry?: Date | null
  ) {
    const current = await CollectionShare.count({
      where: {
        collectionId,
        [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
      },
    });
    await EntitlementService.assertCanShareWith(ownerId, current, adding);
    const changedExpiry =
      !!expiresAt && (!previousExpiry || new Date(previousExpiry).getTime() !== expiresAt.getTime());
    if (changedExpiry) await EntitlementService.assertCanUseShareExpiry(ownerId);
  }

  async shareWithMany(
    collectionId: number,
    ownerId: number,
    identifiers: string[],
    permission: SharePermission = "view",
    expiresAt: Date | null = null,
    e2eKeys?: unknown
  ) {
    const unique = [
      ...new Set(identifiers.map((id) => id?.trim()).filter(Boolean)),
    ] as string[];
    const shared: any[] = [];
    const failed: { identifier: string; message: string }[] = [];
    // Before the per-person loop, which reports errors as failed people.
    const owned = await Collection.findOne({ where: { id: collectionId, userId: ownerId }, attributes: ["id", "companyId"] });
    if (owned && !owned.companyId && unique.length) {
      const people = await User.findAll({
        where: { [Op.or]: [{ email: { [Op.in]: unique } }, { username: { [Op.in]: unique } }] },
        attributes: ["id"],
      });
      const already = await CollectionShare.findAll({
        where: { collectionId, sharedWithUserId: { [Op.in]: people.map((person) => person.id) } },
        attributes: ["sharedWithUserId"],
      });
      await this.assertPlanAllowsShares(ownerId, collectionId, people.length - already.length, expiresAt);
    }
    if (owned && unique.length) {
      const recipients = await User.findAll({
        where: { [Op.or]: [{ email: { [Op.in]: unique } }, { username: { [Op.in]: unique } }] },
        attributes: ["id"],
      });
      await E2EItemService.ensureCollectionShare(ownerId, collectionId, recipients.map((user) => user.id), e2eKeys);
    }

    for (const identifier of unique) {
      try {
        shared.push(
          await this.share(collectionId, ownerId, identifier, permission, expiresAt)
        );
      } catch (error: any) {
        failed.push({
          identifier,
          message: error.message || "Could not share",
        });
      }
    }

    return { shared, failed };
  }

  /** Stop seeing a personal collection someone shared with you. */
  async leave(collectionId: number, userId: number) {
    const collection = await Collection.findByPk(collectionId);
    if (!collection) {
      throw Object.assign(new Error("Collection not found"), { status: 404 });
    }
    if (collection.companyId) {
      throw Object.assign(
        new Error("Company collections follow your access in the company. Ask a company admin."),
        { status: 400 }
      );
    }
    if (collection.userId === userId) {
      throw Object.assign(new Error("You own this collection"), { status: 400 });
    }
    const deleted = await CollectionShare.destroy({
      where: { collectionId, sharedWithUserId: userId },
    });
    if (!deleted) {
      throw Object.assign(new Error("This collection is not shared with you"), { status: 404 });
    }
    return { name: collectionLabel(collection), ownerId: collection.userId };
  }

  async revoke(collectionId: number, ownerId: number, sharedWithUserId: number) {
    const collection = await Collection.findOne({
      where: { id: collectionId, userId: ownerId },
    });
    if (!collection) return false;
    const deleted = await CollectionShare.destroy({
      where: { collectionId, sharedWithUserId },
    });
    return deleted > 0;
  }

  private async noteCounts(collectionIds: number[]) {
    const links = await this.linksForCollections(collectionIds);
    const map = new Map<number, Set<number>>();
    for (const link of links) {
      const set = map.get(link.collectionId) || new Set<number>();
      set.add(link.noteId);
      map.set(link.collectionId, set);
    }
    return new Map([...map.entries()].map(([id, set]) => [id, set.size]));
  }

  private async restorePrimaryCollection(noteId: number) {
    const links = await CollectionNote.findAll({
      where: { noteId },
      include: [
        {
          model: Collection,
          as: "collection",
          attributes: ["id", "name", "encName", "companyId"],
        },
      ],
    });
    const collections = links
      .map((link) => link.get("collection") as Collection | undefined)
      .filter((collection): collection is Collection => Boolean(collection));
    const primary =
      collections.find((collection) => !collection.companyId) || collections[0];
    if (!primary) return;
    await Note.update(
      { collectionId: primary.id, project: collectionLabel(primary) || null },
      { where: { id: noteId, collectionId: { [Op.is]: null } } }
    );
  }
}

export default new CollectionService();
