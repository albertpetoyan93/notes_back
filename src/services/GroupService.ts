import { Op, QueryTypes, UniqueConstraintError } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Collection from "../models/Collection";
import Company from "../models/Company";
import { CollectionGroupShare, CompanyGroup, CompanyGroupMember, GroupRequest } from "../models/CompanyGroup";
import CompanyMember from "../models/CompanyMember";
import { SharePermission } from "../models/NoteShare";
import User from "../models/User";
import NotificationService from "./NotificationService";

/**
 * Groups in companies (plans/vault-features.md, phase B).
 *
 * Owners and admins make groups of members and share company collections with them. A
 * member's access to a company collection is the best of: everyone, their groups, and a
 * share to them by name. Keys don't change shape: E2EItemService.membersOf counts group
 * members, so owners' and admins' browsers hand them the collection key, and replace it
 * when someone leaves a group, exactly as for other members.
 *
 * Members see the company's groups and can ask to join one (collection names are
 * encrypted, so they can't ask for a collection they can't see).
 */

export class GroupError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const better = (a?: SharePermission | null, b?: SharePermission | null): SharePermission | null =>
  a === "edit" || b === "edit" ? "edit" : a || b || null;

const personName = (user?: Pick<User, "fullName" | "username" | "email"> | null) =>
  user?.fullName?.trim() || user?.username || user?.email || "";

class GroupService {
  // ---------------------------------------------------------------- access (used by the access rules)

  /**
   * For each collection, who reaches it through a group, with the best permission.
   * `userId`: only that person. Membership in the company is checked by the caller.
   */
  async byCollection(collectionIds: number[], userId?: number) {
    const result = new Map<number, Map<number, SharePermission>>();
    const ids = [...new Set(collectionIds.filter((id) => Number.isInteger(id)))];
    if (!ids.length) return result;
    const rows = await sequelize.query<{ collectionId: number; userId: number; permission: SharePermission }>(
      `SELECT s."collectionId", m."userId", s."permission"
         FROM "collection_group_shares" s
         JOIN "company_group_members" m ON m."groupId" = s."groupId"
        WHERE s."collectionId" IN (:ids)${userId ? ` AND m."userId" = :userId` : ""}`,
      { replacements: { ids, userId }, type: QueryTypes.SELECT }
    );
    for (const row of rows) {
      const people = result.get(row.collectionId) || new Map<number, SharePermission>();
      people.set(row.userId, better(people.get(row.userId), row.permission) as SharePermission);
      result.set(row.collectionId, people);
    }
    return result;
  }

  /** This person's best permission per collection through their groups. */
  async forUser(userId: number, collectionIds: number[]) {
    const byCollection = await this.byCollection(collectionIds, userId);
    return new Map([...byCollection.entries()].map(([collectionId, people]) => [collectionId, people.get(userId) as SharePermission]));
  }

  /** The groups each collection is shared with, for owners and admins. */
  async sharesOf(collectionIds: number[]) {
    const result = new Map<number, { groupId: number; name: string; permission: SharePermission; members: number }[]>();
    if (!collectionIds.length) return result;
    const shares = await CollectionGroupShare.findAll({ where: { collectionId: { [Op.in]: collectionIds } } });
    if (!shares.length) return result;
    const groupIds = [...new Set(shares.map((share) => share.groupId))];
    const groups = await CompanyGroup.findAll({ where: { id: { [Op.in]: groupIds } } });
    const counts = await this.memberCounts(groupIds);
    for (const share of shares) {
      const group = groups.find((row) => row.id === share.groupId);
      if (!group) continue;
      const list = result.get(share.collectionId) || [];
      list.push({ groupId: group.id, name: group.name, permission: share.permission, members: counts.get(group.id) || 0 });
      list.sort((a, b) => a.name.localeCompare(b.name));
      result.set(share.collectionId, list);
    }
    return result;
  }

  // ---------------------------------------------------------------- groups (owners and admins)

  /**
   * The company's groups. Owners and admins get members, collections and open requests;
   * members get the names, whether they're in each, and whether they asked to join.
   */
  async list(companyId: number, userId: number) {
    const me = await this.membership(companyId, userId);
    const groups = await CompanyGroup.findAll({ where: { companyId }, order: [["name", "ASC"]] });
    const ids = groups.map((group) => group.id);
    const memberRows = ids.length ? await CompanyGroupMember.findAll({ where: { groupId: { [Op.in]: ids } } }) : [];
    // Only people still active in the company count.
    const active = await CompanyMember.findAll({ where: { companyId, status: "active", userId: { [Op.not]: null } } });
    const activeIds = new Set(active.map((row) => row.userId as number));
    const inGroup = memberRows.filter((row) => activeIds.has(row.userId));
    const openRequests = ids.length
      ? await GroupRequest.findAll({ where: { groupId: { [Op.in]: ids }, status: "open" }, order: [["createdAt", "ASC"]] })
      : [];

    if (me.role === "member") {
      return {
        manager: false,
        groups: groups.map((group) => ({
          id: group.id,
          name: group.name,
          members: inGroup.filter((row) => row.groupId === group.id).length,
          isMember: inGroup.some((row) => row.groupId === group.id && row.userId === userId),
          requested: openRequests.some((row) => row.groupId === group.id && row.userId === userId),
        })),
      };
    }

    const users = await User.findAll({
      where: { id: { [Op.in]: [...new Set([...inGroup.map((row) => row.userId), ...openRequests.map((row) => row.userId)])] } },
      attributes: ["id", "email", "fullName", "username"],
    });
    const person = (id: number) => {
      const user = users.find((row) => row.id === id);
      return { userId: id, email: user?.email || "", name: personName(user) };
    };
    const shares = ids.length ? await CollectionGroupShare.findAll({ where: { groupId: { [Op.in]: ids } } }) : [];
    return {
      manager: true,
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        members: inGroup.filter((row) => row.groupId === group.id).map((row) => person(row.userId)),
        collections: shares
          .filter((share) => share.groupId === group.id)
          .map((share) => ({ collectionId: share.collectionId, permission: share.permission })),
        requests: openRequests
          .filter((row) => row.groupId === group.id)
          .map((row) => ({ id: row.id, ...person(row.userId), note: row.note || null, createdAt: row.createdAt.toISOString() })),
      })),
    };
  }

  async create(companyId: number, userId: number, name: unknown) {
    await this.requireManager(companyId, userId);
    try {
      const group = await CompanyGroup.create({ companyId, name: this.checkName(name) });
      return { id: group.id, name: group.name };
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw new GroupError("There's already a group with that name.", 409);
      throw error;
    }
  }

  async rename(companyId: number, userId: number, groupId: number, name: unknown) {
    const group = await this.managedGroup(companyId, userId, groupId);
    try {
      await group.update({ name: this.checkName(name) });
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw new GroupError("There's already a group with that name.", 409);
      throw error;
    }
    return { id: group.id, name: group.name };
  }

  /** Deleting a group takes away what it gave; keys are replaced by the next owner's or admin's browser. */
  async remove(companyId: number, userId: number, groupId: number) {
    const group = await this.managedGroup(companyId, userId, groupId);
    await group.destroy();
    return { name: group.name };
  }

  async addMembers(companyId: number, userId: number, groupId: number, userIds: unknown) {
    const group = await this.managedGroup(companyId, userId, groupId);
    const wanted = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).map(Number).filter(Number.isInteger))];
    if (!wanted.length) throw new GroupError("Choose at least one person.");
    const members = await CompanyMember.findAll({
      where: { companyId, status: "active", userId: { [Op.in]: wanted } },
      attributes: ["userId"],
    });
    if (members.length !== wanted.length) throw new GroupError("Only active members of the company can be added.");
    const existing = await CompanyGroupMember.findAll({ where: { groupId, userId: { [Op.in]: wanted } } });
    const added = wanted.filter((id) => !existing.some((row) => row.userId === id));
    for (const id of added) await CompanyGroupMember.create({ groupId, userId: id, addedBy: userId });
    // Asking to join is answered by being added.
    await GroupRequest.update(
      { status: "approved", decidedBy: userId, decidedAt: new Date() },
      { where: { groupId, userId: { [Op.in]: added }, status: "open" } }
    );
    const company = await Company.findByPk(companyId, { attributes: ["name"] });
    for (const id of added) {
      await NotificationService.create(id, `You were added to ${group.name} in ${company?.name || "your company"}.`);
    }
    return { added, group: group.name };
  }

  async removeMember(companyId: number, userId: number, groupId: number, memberUserId: number) {
    const group = await this.managedGroup(companyId, userId, groupId);
    const removed = await CompanyGroupMember.destroy({ where: { groupId, userId: memberUserId } });
    if (!removed) throw new GroupError("That person isn't in this group.", 404);
    return { group: group.name };
  }

  /** Share a company collection with a group (or change its permission). */
  async shareCollection(companyId: number, userId: number, collectionId: number, groupId: number, permission: unknown) {
    const group = await this.managedGroup(companyId, userId, groupId);
    const collection = await Collection.findOne({ where: { id: collectionId, companyId }, attributes: ["id"] });
    if (!collection) throw new GroupError("Collection not found", 404);
    const next: SharePermission = permission === "edit" ? "edit" : "view";
    const existing = await CollectionGroupShare.findOne({ where: { collectionId, groupId } });
    if (existing) await existing.update({ permission: next });
    else await CollectionGroupShare.create({ collectionId, groupId, permission: next });
    return { group: group.name, permission: next };
  }

  async unshareCollection(companyId: number, userId: number, collectionId: number, groupId: number) {
    const group = await this.managedGroup(companyId, userId, groupId);
    const removed = await CollectionGroupShare.destroy({ where: { collectionId, groupId } });
    if (!removed) throw new GroupError("This collection isn't shared with that group.", 404);
    return { group: group.name };
  }

  /** Gone from the company: out of its groups, and their open requests closed. */
  async leaveCompany(companyId: number, memberUserId: number) {
    const ids = (await CompanyGroup.findAll({ where: { companyId }, attributes: ["id"] })).map((group) => group.id);
    if (!ids.length) return;
    await CompanyGroupMember.destroy({ where: { groupId: { [Op.in]: ids }, userId: memberUserId } });
    await GroupRequest.update({ status: "declined", decidedAt: new Date() }, {
      where: { groupId: { [Op.in]: ids }, userId: memberUserId, status: "open" },
    });
  }

  // ---------------------------------------------------------------- asking to join

  async request(companyId: number, userId: number, groupId: number, note: unknown) {
    await this.membership(companyId, userId);
    const group = await CompanyGroup.findOne({ where: { id: groupId, companyId } });
    if (!group) throw new GroupError("Group not found", 404);
    if (await CompanyGroupMember.count({ where: { groupId, userId } })) throw new GroupError("You're already in this group.", 409);
    const text = String(note || "").trim().slice(0, 500) || null;
    try {
      await GroupRequest.create({ groupId, userId, note: text });
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw new GroupError("You already asked to join this group.", 409);
      throw error;
    }
    const managers = await CompanyMember.findAll({
      where: { companyId, status: "active", role: { [Op.in]: ["owner", "admin"] }, userId: { [Op.not]: null } },
      attributes: ["userId"],
    });
    const me = await User.findByPk(userId, { attributes: ["fullName", "username", "email"] });
    for (const manager of managers) {
      await NotificationService.create(manager.userId as number, `${personName(me) || "A member"} asked to join ${group.name}.`);
    }
    return { group: group.name };
  }

  async cancelRequest(companyId: number, userId: number, groupId: number) {
    const group = await CompanyGroup.findOne({ where: { id: groupId, companyId }, attributes: ["id"] });
    if (!group) throw new GroupError("Group not found", 404);
    const removed = await GroupRequest.destroy({ where: { groupId, userId, status: "open" } });
    if (!removed) throw new GroupError("No request to cancel.", 404);
  }

  /** An owner or admin answers a request. Approving adds them to the group. */
  async decide(companyId: number, userId: number, requestId: number, approve: boolean) {
    const request = await GroupRequest.findOne({ where: { id: requestId, status: "open" } });
    if (!request) throw new GroupError("Request not found", 404);
    const group = await this.managedGroup(companyId, userId, request.groupId);
    const stillMember = await CompanyMember.count({ where: { companyId, userId: request.userId, status: "active" } });
    if (approve && !stillMember) throw new GroupError("That person is no longer in the company.", 409);
    if (approve) {
      await this.addMembers(companyId, userId, group.id, [request.userId]);
    } else {
      await request.update({ status: "declined", decidedBy: userId, decidedAt: new Date() });
      await NotificationService.create(request.userId, `Your request to join ${group.name} was declined.`);
    }
    return { group: group.name, userId: request.userId };
  }

  // ---------------------------------------------------------------- helpers

  private async memberCounts(groupIds: number[]) {
    const rows = await sequelize.query<{ groupId: number; count: string }>(
      `SELECT m."groupId", COUNT(*) AS count
         FROM "company_group_members" m
         JOIN "company_groups" g ON g.id = m."groupId"
         JOIN "company_members" c ON c."companyId" = g."companyId" AND c."userId" = m."userId" AND c."status" = 'active'
        WHERE m."groupId" IN (:groupIds)
        GROUP BY m."groupId"`,
      { replacements: { groupIds }, type: QueryTypes.SELECT }
    );
    return new Map(rows.map((row) => [Number(row.groupId), Number(row.count)]));
  }

  private checkName(value: unknown) {
    const name = String(value || "").trim().replace(/\s+/g, " ");
    if (!name) throw new GroupError("Give the group a name.");
    if (name.length > 80) throw new GroupError("Keep the name under 80 characters.");
    return name;
  }

  private async membership(companyId: number, userId: number) {
    const company = await Company.findByPk(companyId, { attributes: ["id", "status"] });
    if (!company || company.status !== "active") throw new GroupError("Company not found", 404);
    const member = await CompanyMember.findOne({ where: { companyId, userId, status: "active" } });
    if (!member) throw new GroupError("Company not found", 404);
    return member;
  }

  private async requireManager(companyId: number, userId: number) {
    const member = await this.membership(companyId, userId);
    if (member.role === "member") throw new GroupError("Only owners and admins can manage groups.", 403);
    return member;
  }

  private async managedGroup(companyId: number, userId: number, groupId: number) {
    await this.requireManager(companyId, userId);
    const group = await CompanyGroup.findOne({ where: { id: groupId, companyId } });
    if (!group) throw new GroupError("Group not found", 404);
    return group;
  }
}

export default new GroupService();
