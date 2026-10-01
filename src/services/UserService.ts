import User from "@src/models/User";
import CompanyMember from "@src/models/CompanyMember";
import { Op } from "sequelize";

class UserService {
  /**
   * Get user by ID
   */
  static async getUserById(userId: number) {
    const user = await User.findByPk(userId, {
      attributes: ["id", "username", "email", "fullName", "createdAt"],
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

    return User.findAll({
      where: {
        id: ids ? { [Op.in]: ids } : { [Op.ne]: excludeUserId },
        [Op.or]: [
          { email: { [Op.iLike]: `%${q}%` } },
          { username: { [Op.iLike]: `%${q}%` } },
          { fullName: { [Op.iLike]: `%${q}%` } },
        ],
      },
      attributes: ["id", "username", "email", "fullName"],
      limit: 8,
      order: [["username", "ASC"]],
    });
  }

  /**
   * Update user profile
   */
  static async updateProfile(
    userId: number,
    data: { email?: string; fullName?: string; password?: string }
  ) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new Error("User not found");
    }

    await user.update({
      email: data.email !== undefined ? data.email : user.email,
      fullName: data.fullName !== undefined ? data.fullName : user.fullName,
      password: data.password !== undefined ? data.password : user.password,
    });

    return user;
  }
}

export default UserService;
