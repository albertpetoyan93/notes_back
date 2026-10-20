import User from "../models/User";
import CompanyService from "./CompanyService";
import EmailService from "./EmailService";
import logger from "jet-logger";
import { Op } from "sequelize";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import EnvVars from "../common/EnvVars";
import { SessionKind } from "../models/UserSession";
import SessionService, { SessionMeta } from "./SessionService";

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

  static issueSession(user: User, meta: SessionMeta = {}) {
    return SessionService.create(user.id, "web", meta);
  }

  /**
   * Exchange a valid refresh token for a new access token and a new refresh token.
   * The previous refresh token stops working.
   */
  static rotateSession(refreshToken?: string, meta: SessionMeta = {}) {
    return SessionService.rotate(refreshToken, "web", meta);
  }

  static async issueExtensionSession(user: User, meta: SessionMeta = {}) {
    const session = await SessionService.create(user.id, "extension", meta);
    return { accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  static async rotateExtensionSession(refreshToken?: string, meta: SessionMeta = {}) {
    const session = await SessionService.rotate(refreshToken, "extension", meta);
    return { accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  static revokeExtensionSession(refreshToken?: string) {
    return SessionService.revokeByToken(refreshToken, "extension");
  }

  /**
   * Password was right but 2FA is on: a short-lived token that only
   * /2fa/verify accepts, so the code step does not ask for the password again.
   */
  static createLoginChallenge(user: User, kind: SessionKind) {
    return jwt.sign({ userId: user.id, type: "2fa", kind }, EnvVars.Jwt.Secret, {
      expiresIn: "5m",
    });
  }

  static async readLoginChallenge(token: string | undefined, kind: SessionKind) {
    try {
      const decoded = jwt.verify(String(token || ""), EnvVars.Jwt.Secret);
      if (
        typeof decoded !== "string" &&
        decoded.type === "2fa" &&
        decoded.kind === kind &&
        decoded.userId
      ) {
        const user = await User.findByPk(decoded.userId);
        if (user && user.twoFactorEnabled) return user;
      }
    } catch {
      // Falls through to the error below.
    }
    throw new Error("Sign-in expired. Enter your password again.");
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
    });
    await SessionService.revokeAll(user.id);
    return user.id;
  }

  static revokeSession(refreshToken?: string) {
    return SessionService.revokeByToken(refreshToken, "web");
  }
}

export default AuthService;
