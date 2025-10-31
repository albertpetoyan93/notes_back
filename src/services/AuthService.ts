import User from "../models/User";
import { Op } from "sequelize";
import jwt from "jsonwebtoken";
import EnvVars from "../common/EnvVars";

interface RegisterData {
  username: string;
  email: string;
  password: string;
  fullName?: string;
}

interface LoginData {
  email: string;
  password: string;
}

class AuthService {
  /**
   * Register a new user
   */
  static async register(data: RegisterData) {
    // Check if user already exists
    const existingUser = await User.findOne({
      where: {
        [Op.or]: [{ username: data.username }, { email: data.email }],
      },
    });

    if (existingUser) {
      throw new Error("Username or email already exists");
    }

    // Create new user (password will be hashed by the model hook)
    const user = await User.create({
      username: data.username,
      email: data.email,
      password: data.password,
      fullName: data.fullName,
    });

    return user;
  }

  /**
   * Login user
   */
  static async login(data: LoginData) {
    // Find user by email
    const user = await User.findOne({ where: { email: data.email } });

    if (!user) {
      throw new Error("Invalid credentials");
    }

    // Check password
    const isPasswordValid = await user.comparePassword(data.password);

    if (!isPasswordValid) {
      throw new Error("Invalid credentials");
    }

    return user;
  }

  /**
   * Generate JWT token
   */
  static generateToken(userId: number, role: string = "user") {
    const data = {
      userId,
      role,
    };

    const token = jwt.sign(data, EnvVars.Jwt.Secret, {
      expiresIn: EnvVars.Jwt.Exp,
    });

    return token;
  }
}

export default AuthService;
