import User from "@src/models/User";

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
