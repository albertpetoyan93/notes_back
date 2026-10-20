import { Op } from "sequelize";
import Collection from "../models/Collection";
import CollectionShare from "../models/CollectionShare";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import Note from "../models/Note";
import NoteShare from "../models/NoteShare";
import User from "../models/User";
import CollectionService from "./CollectionService";

/** One way a person reaches an item. */
export type AccessRoute =
  | { type: "direct"; permission: "view" | "edit"; expiresAt: Date | null }
  | {
      type: "collection";
      collectionId: number;
      collectionName: string;
      permission: "view" | "edit";
      expiresAt: Date | null;
      /** True when they own the collection the item was added to. */
      collectionOwner?: boolean;
    }
  | {
      type: "company";
      collectionId: number;
      collectionName: string;
      permission: "view" | "edit";
      /** owner/admin see every company collection; members need a share. */
      role: "owner" | "admin" | "member";
      everyone: boolean;
    };

export interface AccessPerson {
  userId: number;
  name: string;
  email: string;
  routes: AccessRoute[];
}

type UserRow = Pick<User, "id" | "username" | "email" | "fullName">;

const USER_ATTRIBUTES = ["id", "username", "email", "fullName"];
const notExpired = { [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }] };

/**
 * Everyone who can open an item, other than its owner, and how. Mirrors the
 * rules in NoteService.getNoteAccess so the list matches what people see.
 */
class AccessService {
  async peopleByNote(noteIds: number[]) {
    const result = new Map<number, AccessPerson[]>();
    const ids = [...new Set(noteIds)];
    if (!ids.length) return result;

    const notes = await Note.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ["id", "userId"],
      paranoid: false,
    });
    const ownerByNote = new Map(notes.map((note) => [note.id, note.userId]));
    const linked = await CollectionService.collectionsByNoteId(ids);
    const collectionIds = [...new Set([...linked.values()].flat().map((item) => item.id))];
    const collections = collectionIds.length
      ? await Collection.findAll({
          where: { id: { [Op.in]: collectionIds } },
          attributes: ["id", "name", "userId", "companyId", "companyShare"],
        })
      : [];
    const collectionById = new Map(collections.map((item) => [item.id, item]));

    const users = new Map<number, UserRow>();
    const remember = (user: UserRow | null | undefined) => {
      if (user) users.set(user.id, user);
    };

    const directShares = await NoteShare.findAll({
      where: { noteId: { [Op.in]: ids }, ...notExpired },
      include: [{ model: User, as: "sharedWith", attributes: USER_ATTRIBUTES }],
    });
    directShares.forEach((share) => remember(share.get("sharedWith") as UserRow));

    const collectionShares = collectionIds.length
      ? await CollectionShare.findAll({
          where: { collectionId: { [Op.in]: collectionIds }, ...notExpired },
          include: [{ model: User, as: "sharedWith", attributes: USER_ATTRIBUTES }],
        })
      : [];
    collectionShares.forEach((share) => remember(share.get("sharedWith") as UserRow));

    const companyIds = [
      ...new Set(collections.map((item) => item.companyId).filter((id): id is number => !!id)),
    ];
    const activeCompanyIds = companyIds.length
      ? new Set(
          (
            await Company.findAll({
              where: { id: { [Op.in]: companyIds }, status: "active" },
              attributes: ["id"],
            })
          ).map((company) => company.id)
        )
      : new Set<number>();
    const members = activeCompanyIds.size
      ? await CompanyMember.findAll({
          where: {
            companyId: { [Op.in]: [...activeCompanyIds] },
            status: "active",
            userId: { [Op.not]: null },
          },
          include: [{ model: User, as: "user", attributes: USER_ATTRIBUTES }],
        })
      : [];
    members.forEach((member) => remember(member.get("user") as UserRow));

    const collectionOwnerIds = collections
      .filter((item) => !item.companyId)
      .map((item) => item.userId)
      .filter((id) => !users.has(id));
    if (collectionOwnerIds.length) {
      (
        await User.findAll({
          where: { id: { [Op.in]: collectionOwnerIds } },
          attributes: USER_ATTRIBUTES,
        })
      ).forEach(remember);
    }

    for (const noteId of ids) {
      const ownerId = ownerByNote.get(noteId);
      const routes = new Map<number, AccessRoute[]>();
      const add = (userId: number, route: AccessRoute) => {
        if (userId === ownerId || !users.has(userId)) return;
        routes.set(userId, [...(routes.get(userId) || []), route]);
      };

      const noteCollections = (linked.get(noteId) || [])
        .map((item) => collectionById.get(item.id))
        .filter((item): item is Collection => !!item);
      const companyCollections = noteCollections.filter(
        (item) => item.companyId && activeCompanyIds.has(item.companyId)
      );

      if (companyCollections.length) {
        // Company items: membership decides, through each company collection.
        for (const collection of companyCollections) {
          for (const member of members) {
            if (member.companyId !== collection.companyId || !member.userId) continue;
            const role = member.role as "owner" | "admin" | "member";
            const share = collectionShares.find(
              (item) =>
                item.collectionId === collection.id &&
                item.sharedWithUserId === member.userId
            );
            const permission =
              role !== "member"
                ? "edit"
                : share?.permission || collection.companyShare || null;
            if (!permission) continue;
            add(member.userId, {
              type: "company",
              collectionId: collection.id,
              collectionName: collection.name,
              permission,
              role,
              everyone: role === "member" && !share && !!collection.companyShare,
            });
          }
        }
        for (const share of directShares) {
          if (share.noteId !== noteId) continue;
          const isMember = members.some(
            (member) =>
              member.userId === share.sharedWithUserId &&
              companyCollections.some((item) => item.companyId === member.companyId)
          );
          if (isMember) {
            add(share.sharedWithUserId, {
              type: "direct",
              permission: share.permission,
              expiresAt: share.expiresAt ?? null,
            });
          }
        }
      } else {
        for (const share of directShares) {
          if (share.noteId !== noteId) continue;
          add(share.sharedWithUserId, {
            type: "direct",
            permission: share.permission,
            expiresAt: share.expiresAt ?? null,
          });
        }
        for (const collection of noteCollections) {
          for (const share of collectionShares) {
            if (share.collectionId !== collection.id) continue;
            add(share.sharedWithUserId, {
              type: "collection",
              collectionId: collection.id,
              collectionName: collection.name,
              permission: share.permission,
              expiresAt: share.expiresAt ?? null,
            });
          }
          // Someone else's collection that this item was added to.
          if (collection.userId !== ownerId) {
            add(collection.userId, {
              type: "collection",
              collectionId: collection.id,
              collectionName: collection.name,
              permission: "edit",
              expiresAt: null,
              collectionOwner: true,
            });
          }
        }
      }

      result.set(
        noteId,
        [...routes.entries()]
          .map(([userId, list]) => {
            const user = users.get(userId) as UserRow;
            return {
              userId,
              name: user.fullName || user.username,
              email: user.email,
              routes: list,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name))
      );
    }

    return result;
  }

  /** How many people (besides the owner) can open each item. */
  async countsByNote(noteIds: number[]) {
    const people = await this.peopleByNote(noteIds);
    return new Map([...people.entries()].map(([noteId, list]) => [noteId, list.length]));
  }
}

export default new AccessService();
