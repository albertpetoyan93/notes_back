import User from "../models/User";
import CompanyService from "./CompanyService";
import EmailService from "./EmailService";
import logger from "jet-logger";
import { Op } from "sequelize";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import EnvVars from "../common/EnvVars";

const RESET_MESSAGE =
  "If an account exists for that email, we sent a reset link.";

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

    await CompanyService.claimInvites(user.id, user.email);

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

  static async issueExtensionSession(user: User) {
    const extensionRefreshTokenId = crypto.randomBytes(32).toString("hex");
    await user.update({ extensionRefreshTokenId });

    return {
      accessToken: this.signAccessToken(user.id),
      refreshToken: this.signRefreshToken(user.id, extensionRefreshTokenId),
    };
  }

  static async rotateExtensionSession(refreshToken?: string) {
    const payload = this.readRefreshPayload(refreshToken);
    const user = await User.findByPk(payload.userId);
    if (!user || user.extensionRefreshTokenId !== payload.jti) {
      throw new Error("Invalid refresh token");
    }

    return this.issueExtensionSession(user);
  }

  static async revokeExtensionSession(refreshToken?: string) {
    if (!refreshToken) return;

    try {
      const payload = this.readRefreshPayload(refreshToken);
      const user = await User.findByPk(payload.userId);
      if (user && user.extensionRefreshTokenId === payload.jti) {
        await user.update({ extensionRefreshTokenId: null });
      }
    } catch {
      return;
    }
  }

  static async requestPasswordReset(email: string) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized) return RESET_MESSAGE;

    const user = await User.findOne({
      where: { email: { [Op.iLike]: normalized } },
    });
    if (!user) return RESET_MESSAGE;

    const token = crypto.randomBytes(32).toString("hex");
    const passwordResetTokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");
    const passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.update({ passwordResetTokenHash, passwordResetExpires });

    if (!EmailService.isConfigured()) {
      const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
      logger.info(
        `Password reset link for ${user.email}: ${origin}/auth/reset?token=${token}`
      );
      return RESET_MESSAGE;
    }

    try {
      await EmailService.sendPasswordReset({ to: user.email, token });
    } catch (error) {
      logger.err(error, true);
    }
    return RESET_MESSAGE;
  }

  static async resetPassword(token: string, password: string) {
    if (String(password || "").length < 6) {
      throw new Error("Password must be at least 6 characters.");
    }

    const raw = String(token || "").trim();
    if (!raw) {
      throw new Error("This reset link is invalid or has expired.");
    }

    const passwordResetTokenHash = crypto
      .createHash("sha256")
      .update(raw)
      .digest("hex");
    const user = await User.findOne({ where: { passwordResetTokenHash } });
    const expires = user?.passwordResetExpires
      ? new Date(user.passwordResetExpires).getTime()
      : 0;
    if (!user || !user.passwordResetTokenHash || expires < Date.now()) {
      throw new Error("This reset link is invalid or has expired.");
    }

    const stored = Buffer.from(user.passwordResetTokenHash);
    const given = Buffer.from(passwordResetTokenHash);
    if (
      stored.length !== given.length ||
      !crypto.timingSafeEqual(stored, given)
    ) {
      throw new Error("This reset link is invalid or has expired.");
    }

    await user.update({
      password,
      passwordResetTokenHash: null,
      passwordResetExpires: null,
      refreshTokenId: null,
      extensionRefreshTokenId: null,
    });
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

  private static readRefreshPayload(refreshToken?: string) {
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

    return payload;
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
