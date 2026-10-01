import { Op } from "sequelize";
import Collection from "../models/Collection";
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
    const counts = ids.length
      ? ((await Note.count({
          where: { collectionId: { [Op.in]: ids } },
          group: ["collectionId"],
        })) as unknown as { collectionId: number; count: string }[])
      : [];
    const countById = new Map<number, number>(
      counts.map((row) => [Number(row.collectionId), Number(row.count)])
    );

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
    const counts = ids.length
      ? ((await Note.count({
          where: { collectionId: { [Op.in]: ids } },
          group: ["collectionId"],
        })) as unknown as { collectionId: number; count: string }[])
      : [];
    const countById = new Map<number, number>(
      counts.map((row) => [Number(row.collectionId), Number(row.count)])
    );
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
    await Note.update(
      { collectionId: null, project: null },
      { where: { collectionId } }
    );
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

    await Note.update(
      { collectionId, project: access.collection.name },
      { where: { id: { [Op.in]: notes.map((note) => note.id) } } }
    );

    return { added: notes.length, skipped: ids.length - notes.length };
  }

  async removeNote(collectionId: number, userId: number, noteId: number) {
    const access = await this.getAccess(collectionId, userId);
    const note = await Note.findOne({ where: { id: noteId, collectionId } });
    if (!note || !access) return false;

    const canRemove =
      access.permission === "owner" || note.userId === userId;
    if (!canRemove) return false;

    await note.update({ collectionId: null, project: null });
    return true;
  }

  async availableNotes(collectionId: number, userId: number) {
    await this.assertCanAdd(collectionId, userId);
    const notes = await Note.findAll({
      where: {
        userId,
        [Op.or]: [
          { collectionId: null },
          { collectionId: { [Op.ne]: collectionId } },
        ],
      },
      attributes: ["id", "title", "collectionId"],
      order: [["title", "ASC"]],
    });
    return notes;
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
}

export default new CollectionService();
