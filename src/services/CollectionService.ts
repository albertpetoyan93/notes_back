import { Op } from "sequelize";
import Collection from "../models/Collection";
import CollectionNote from "../models/CollectionNote";
import CollectionShare from "../models/CollectionShare";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import Note from "../models/Note";
import User from "../models/User";
import { SharePermission } from "../models/NoteShare";
import NotificationService from "./NotificationService";

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

    return collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      isOwner: collection.userId === userId,
      permission:
        collection.userId === userId
          ? "owner"
          : permissionById.get(collection.id) || "view",
      noteCount: countById.get(collection.id) || 0,
    }));
  }

  async create(userId: number, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw Object.assign(new Error("Collection name is required"), {
        status: 400,
      });
    }

    const existing = await Collection.findOne({
      where: { userId, name: trimmed, companyId: { [Op.is]: null } },
    });
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
    });
    return {
      id: collection.id,
      name: collection.name,
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
        name: collection.name,
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
    return new Set(companies.map((company) => company.id));
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

    for (const member of memberships) {
      if (!activeIds.has(member.companyId)) continue;
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

  async rename(collectionId: number, userId: number, name: string) {
    const access = await this.getAccess(collectionId, userId);
    if (!access || access.permission !== "owner") return null;

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

  async addNotes(collectionId: number, userId: number, noteIds: number[]) {
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

    for (const note of notes) {
      await this.addNoteToCollection(note.id, collectionId, access.collection.name);
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
      attributes: ["id", "title", "collectionId"],
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
          attributes: ["id", "name", "companyId"],
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
          name: collection.name,
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
            attributes: ["id", "name", "companyId"],
          },
        ],
      });
      for (const note of notes) {
        const collection = (note as Note & { collection?: Collection }).collection;
        if (!collection || !note.collectionId) continue;
        map.set(note.id, [
          {
            id: collection.id,
            name: collection.name,
            companyId: collection.companyId ?? null,
          },
        ]);
      }
    }
    return map;
  }

  async setNoteCollections(noteId: number, collectionIds: number[]) {
    const ids = [...new Set(collectionIds.filter((id) => Number.isInteger(id)))];
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
      await note.update({ collectionId, project: name });
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
      `${ownerName} shared the collection "${collection.name}" with you`
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

  async shareWithMany(
    collectionId: number,
    ownerId: number,
    identifiers: string[],
    permission: SharePermission = "view",
    expiresAt: Date | null = null
  ) {
    const unique = [
      ...new Set(identifiers.map((id) => id?.trim()).filter(Boolean)),
    ] as string[];
    const shared: any[] = [];
    const failed: { identifier: string; message: string }[] = [];

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
          attributes: ["id", "name", "companyId"],
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
      { collectionId: primary.id, project: primary.name },
      { where: { id: noteId, collectionId: { [Op.is]: null } } }
    );
  }
}

export default new CollectionService();
