import User from "@src/models/User";
import CompanyMember from "@src/models/CompanyMember";
import { Op } from "sequelize";

class UserService {
  /**
   * Get user by ID
   */
  static async getUserById(userId: number) {
    const user = await User.findByPk(userId, {
      attributes: [
        "id",
        "username",
        "email",
        "fullName",
        "twoFactorEnabled",
        "autoLockMinutes",
        "extensionAutoLockMinutes",
        "e2eEnabled",
        "mustChangeMasterPassword",
        "emailVerifiedAt",
        "e2eSince",
        "publicKey",
        "createdAt",
      ],
    });

    return user;
  }

  /**
   * Search users by email, username, or name (excludes the caller)
   */
  static async searchUsers(query: string, excludeUserId: number, companyId?: number) {
    const q = query.trim();
    if (q.length < 2) return [];

    let ids: number[] | null = null;
    if (companyId) {
      const caller = await CompanyMember.findOne({
        where: { companyId, userId: excludeUserId, status: "active" },
      });
      if (!caller) return [];
      const members = await CompanyMember.findAll({
        where: {
          companyId,
          status: "active",
          userId: { [Op.and]: [{ [Op.ne]: excludeUserId }, { [Op.not]: null }] },
        },
        attributes: ["userId"],
      });
      ids = members
        .map((member) => member.userId)
        .filter((id): id is number => typeof id === "number");
      if (!ids.length) return [];
    }

    // Typed % and _ are plain characters, not wildcards.
    const text = q.replace(/[\\%_]/g, "\\$&");
    // Inside a company: part of a colleague's name or address. Anywhere else only the exact
    // email or username, so nobody can page through every 2keevo user (SEC06).
    const match = ids
      ? [
          { email: { [Op.iLike]: `%${text}%` } },
          { username: { [Op.iLike]: `%${text}%` } },
          { fullName: { [Op.iLike]: `%${text}%` } },
        ]
      : [{ email: { [Op.iLike]: text } }, { username: { [Op.iLike]: text } }];
    return User.findAll({
      where: {
        id: ids ? { [Op.in]: ids } : { [Op.ne]: excludeUserId },
        // Unconfirmed accounts can't be found by an address they may not own (F15).
        emailVerifiedAt: { [Op.not]: null },
        [Op.or]: match,
      },
      attributes: ["id", "username", "email", "fullName"],
      limit: 8,
      order: [["username", "ASC"]],
    });
  }
}

export default UserService;
