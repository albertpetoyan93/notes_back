import User from "@src/models/User";
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
  static async searchUsers(query: string, excludeUserId: number) {
    const q = query.trim();
    if (q.length < 2) return [];

    return User.findAll({
      where: {
        id: { [Op.ne]: excludeUserId },
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
