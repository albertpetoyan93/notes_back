import { Op, UniqueConstraintError } from "sequelize";
import { FAMILY_MAX_MEMBERS } from "../common/plans";
import Collection from "../models/Collection";
import CollectionShare from "../models/CollectionShare";
import FamilyMember from "../models/FamilyMember";
import User from "../models/User";
import CollectionService from "./CollectionService";
import EmailService from "./EmailService";
import EntitlementService from "./EntitlementService";

const INVITE_MS = 14 * 24 * 60 * 60 * 1000;

export class FamilyError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const openInvite = () => ({
  status: "invited",
  [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
});

const displayName = (user: Pick<User, "fullName" | "username" | "email"> | null) =>
  user?.fullName?.trim() || user?.username || user?.email || "Someone";

/**
 * Family: an organizer pays, and invites up to 5 people by email. Each gets Premium and
 * keeps a private vault; the organizer's family collection is shared with all of them.
 */
class FamilyService {
  /** Invites sent to this email before the account existed now belong to the account. */
  async claimInvites(userId: number, email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    await FamilyMember.update(
      { userId },
      { where: { email: normalized, userId: { [Op.is]: null }, status: "invited", ownerId: { [Op.ne]: userId } } }
    );
  }

  /** What the Billing page shows about families: the one they run or joined, and invites. */
  async summary(userId: number) {
    const user = await User.findByPk(userId, { attributes: ["id", "email"] });
    if (user) await this.claimInvites(userId, user.email);

    const membership = await FamilyMember.findOne({ where: { userId, status: "active" } });
    const invites = await FamilyMember.findAll({ where: { userId, ...openInvite() }, order: [["createdAt", "ASC"]] });
    const organizers = await User.findAll({
      where: { id: { [Op.in]: [...invites.map((invite) => invite.ownerId), membership?.ownerId || 0] } },
      attributes: ["id", "fullName", "username", "email"],
    });
    const organizerName = (id: number) => displayName(organizers.find((row) => row.id === id) || null);

    const organizing = await EntitlementService.forFamily(userId);
    const members = await FamilyMember.findAll({
      where: { ownerId: userId, [Op.or]: [{ status: "active" }, openInvite()] },
      order: [["createdAt", "ASC"]],
    });
    const collection = await Collection.findOne({ where: { userId, family: true }, attributes: ["id", "name"] });
    const shared = collection
      ? new Set(
          (await CollectionShare.findAll({ where: { collectionId: collection.id }, attributes: ["sharedWithUserId"] })).map(
            (share) => share.sharedWithUserId
          )
        )
      : new Set<number>();

    return {
      /** They pay for a Family (trial or paid), or ran one before (members still listed). */
      organizer:
        organizing || members.length
          ? {
              live: !!organizing,
              maxMembers: FAMILY_MAX_MEMBERS,
              members: members.map((member) => ({
                id: member.id,
                email: member.email,
                status: member.status,
                expiresAt: member.expiresAt ? member.expiresAt.toISOString() : null,
                // Active members who can't open the family collection yet: the organizer's browser shares it.
                needsCollection: !!collection && member.status === "active" && !!member.userId && !shared.has(member.userId),
              })),
              collection: collection ? { id: collection.id, name: collection.name } : null,
            }
          : null,
      membership: membership ? { id: membership.id, organizer: organizerName(membership.ownerId) } : null,
      invites: invites.map((invite) => ({
        id: invite.id,
        organizer: organizerName(invite.ownerId),
        expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      })),
    };
  }

  private async requireOrganizer(ownerId: number) {
    if (!(await EntitlementService.forFamily(ownerId))) {
      throw new FamilyError("Start a Family trial or subscribe to Family first.", 403);
    }
  }

  async invite(ownerId: number, email: unknown) {
    await this.requireOrganizer(ownerId);
    const normalized = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new FamilyError("Enter a valid email");

    const owner = await User.findByPk(ownerId, { attributes: ["id", "email", "fullName", "username"] });
    if (!owner) throw new FamilyError("Unauthorized", 401);
    if (normalized === owner.email.trim().toLowerCase()) throw new FamilyError("You are the organizer of this family");

    const taken = await FamilyMember.count({ where: { ownerId, [Op.or]: [{ status: "active" }, openInvite()] } });
    const existing = await FamilyMember.findOne({ where: { ownerId, email: normalized } });
    if (existing?.status === "active") throw new FamilyError("That person is already in your family");
    if (existing && existing.expiresAt && existing.expiresAt > new Date()) {
      throw new FamilyError("That person is already invited");
    }
    if (taken >= FAMILY_MAX_MEMBERS) {
      throw new FamilyError(`Family includes up to ${FAMILY_MAX_MEMBERS} people besides you.`);
    }

    const account = await User.findOne({ where: { email: { [Op.iLike]: normalized } }, attributes: ["id"] });
    const expiresAt = new Date(Date.now() + INVITE_MS);
    const member = existing
      ? await existing.update({ status: "invited", userId: account?.id ?? existing.userId ?? null, expiresAt })
      : await FamilyMember.create({ ownerId, email: normalized, userId: account?.id ?? null, status: "invited", expiresAt });

    let emailSent = false;
    try {
      emailSent = await EmailService.sendFamilyInvite({ to: normalized, organizer: displayName(owner) });
    } catch {
      // The invite still shows in their Billing page once they sign in.
    }
    return { id: member.id, email: member.email, status: member.status, emailSent };
  }

  async accept(userId: number, inviteId: number) {
    const user = await User.findByPk(userId, { attributes: ["id", "email"] });
    if (!user) throw new FamilyError("Unauthorized", 401);
    await this.claimInvites(userId, user.email);

    const invite = await FamilyMember.findOne({ where: { id: inviteId, userId, ...openInvite() } });
    if (!invite) throw new FamilyError("Invite not found or expired", 404);
    if (await EntitlementService.forFamily(userId)) {
      throw new FamilyError("You run a family yourself. Cancel your Family plan to join another.", 409);
    }
    if (!(await EntitlementService.forFamily(invite.ownerId))) {
      throw new FamilyError("This family's plan has ended.", 409);
    }
    try {
      await invite.update({ status: "active", expiresAt: null });
    } catch (error) {
      // The unique index: one active family per person.
      if (error instanceof UniqueConstraintError) throw new FamilyError("You are already in a family. Leave it first.", 409);
      throw error;
    }
    return { id: invite.id, status: invite.status };
  }

  async decline(userId: number, inviteId: number) {
    const deleted = await FamilyMember.destroy({ where: { id: inviteId, userId, status: "invited" } });
    if (!deleted) throw new FamilyError("Invite not found", 404);
  }

  /** The organizer removes someone (or takes back an invite). */
  async remove(ownerId: number, memberId: number) {
    const member = await FamilyMember.findOne({ where: { id: memberId, ownerId } });
    if (!member) throw new FamilyError("That person isn't in your family", 404);
    await this.closeAccess(member);
  }

  async leave(userId: number) {
    const member = await FamilyMember.findOne({ where: { userId, status: "active" } });
    if (!member) throw new FamilyError("You aren't in a family", 404);
    await this.closeAccess(member);
  }

  /** Gone from the family: the family collection closes for them; their own vault stays theirs. */
  private async closeAccess(member: FamilyMember) {
    if (member.userId) {
      const collection = await Collection.findOne({ where: { userId: member.ownerId, family: true }, attributes: ["id"] });
      if (collection) await CollectionService.revoke(collection.id, member.ownerId, member.userId);
    }
    await member.destroy();
  }

  /** Create the family collection, or make one of the organizer's own collections it. */
  async setCollection(ownerId: number, input: { collectionId?: unknown; name?: unknown }) {
    await this.requireOrganizer(ownerId);
    let collection: Collection | null;
    if (input.collectionId) {
      collection = await Collection.findOne({
        where: { id: Number(input.collectionId), userId: ownerId, companyId: { [Op.is]: null } },
      });
      if (!collection) throw new FamilyError("Collection not found", 404);
    } else {
      const created = await CollectionService.create(ownerId, String(input.name || "Family").trim() || "Family");
      collection = await Collection.findByPk((created as { id: number }).id);
      if (!collection) throw new FamilyError("Collection not found", 404);
    }
    await Collection.update({ family: false }, { where: { userId: ownerId, family: true, id: { [Op.ne]: collection.id } } });
    await collection.update({ family: true });
    return { id: collection.id, name: collection.name };
  }
}

export default new FamilyService();
