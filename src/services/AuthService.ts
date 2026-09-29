import User from "../models/User";
import { Op } from "sequelize";
import jwt from "jsonwebtoken";
import crypto from "crypto";
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

  static async issueSession(user: User) {
    const refreshTokenId = crypto.randomBytes(32).toString("hex");
    await user.update({ refreshTokenId });

    return {
      accessToken: this.signAccessToken(user.id),
      refreshToken: this.signRefreshToken(user.id, refreshTokenId),
    };
  }

  /**
   * Exchange a valid refresh token for a new access token and a new refresh token.
   * The previous refresh token stops working.
   */
  static async rotateSession(refreshToken?: string) {
    if (!refreshToken) {
      throw new Error("Invalid refresh token");
    }

    let payload: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(refreshToken, EnvVars.Jwt.Secret);
      if (typeof decoded === "string") {
        throw new Error("Invalid refresh token");
      }
      payload = decoded;
    } catch {
      throw new Error("Invalid refresh token");
    }

    if (payload.type !== "refresh" || !payload.userId || !payload.jti) {
      throw new Error("Invalid refresh token");
    }

    const user = await User.findByPk(payload.userId);
    if (!user || user.refreshTokenId !== payload.jti) {
      throw new Error("Invalid refresh token");
    }

    const refreshTokenId = crypto.randomBytes(32).toString("hex");
    await user.update({ refreshTokenId });

    return {
      accessToken: this.signAccessToken(user.id),
      refreshToken: this.signRefreshToken(user.id, refreshTokenId),
    };
  }

  static async revokeSession(refreshToken?: string) {
    if (!refreshToken) return;

    try {
      const decoded = jwt.verify(refreshToken, EnvVars.Jwt.Secret);
      if (typeof decoded === "string" || decoded.type !== "refresh") return;
      const user = await User.findByPk(decoded.userId);
      if (user && user.refreshTokenId === decoded.jti) {
        await user.update({ refreshTokenId: null });
      }
    } catch {
      return;
    }
  }

  private static signAccessToken(userId: number) {
    return jwt.sign({ userId, type: "access" }, EnvVars.Jwt.Secret, {
      expiresIn: "15m",
    });
  }

  private static signRefreshToken(userId: number, jti: string) {
    return jwt.sign({ userId, type: "refresh", jti }, EnvVars.Jwt.Secret, {
      expiresIn: "7d",
    });
  }
}

export default AuthService;
