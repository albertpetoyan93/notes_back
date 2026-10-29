import User from "../models/User";
import UserPasskey from "../models/UserPasskey";
import CompanyService from "./CompanyService";
import EmailService from "./EmailService";
import FamilyService from "./FamilyService";
import logger from "jet-logger";
import { Op } from "sequelize";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import EnvVars from "../common/EnvVars";
import { SessionKind } from "../models/UserSession";
import SessionService, { SessionMeta } from "./SessionService";
import E2EAccountService from "./E2EAccountService";

const RESET_MESSAGE =
  "If an account exists for that email, we sent a reset link.";

interface RegisterData {
  username: string;
  email: string;
  /** For end-to-end accounts, the sign-in key (as in e2e.password). */
  password: string;
  fullName?: string;
  /** End-to-end keys made in the browser (E2EAccountService.checkedBundle). */
  e2e?: Record<string, unknown>;
}

interface LoginData {
  email: string;
  /** Accounts without end-to-end encryption. */
  password?: string;
  /** Accounts with it: the sign-in key the browser derived from the master password. */
  authKey?: string;
}

/** Thrown when an old app sends a typed password for a master-password account. */
export const E2E_REQUIRED = "E2E_REQUIRED";
export const MASTER_RESET_REFUSED =
  "This account uses a master password, which can't be reset by email. Use your recovery key instead.";

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
      ...(data.e2e ? { ...data.e2e, e2eEnabled: true, e2eSince: new Date() } : {}),
    });

    await CompanyService.claimInvites(user.id, user.email);
    await FamilyService.claimInvites(user.id, user.email);

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

    // Master-password accounts only accept the derived sign-in key. A typed
    // password can never match it, so an old app gets a clear message instead.
    if (user.e2eEnabled) {
      if (!data.authKey) throw new Error(E2E_REQUIRED);
      if (!/^[A-Za-z0-9_-]{43}$/.test(String(data.authKey))) throw new Error("Invalid credentials");
      if (!(await user.comparePassword(String(data.authKey)))) throw new Error("Invalid credentials");
      return user;
    }

    const isPasswordValid = await user.comparePassword(String(data.password ?? ""));

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

    // A master password can't be reset by email: the server can't open the
    // vault, and the old keys would be lost. The email says what does work.
    if (user.e2eEnabled) {
      try {
        if (EmailService.isConfigured()) await EmailService.sendMasterPasswordHelp({ to: user.email });
        else logger.info(`Password reset asked for ${user.email}, an end-to-end account: no link sent.`);
      } catch (error) {
        logger.err(error, true);
      }
      return RESET_MESSAGE;
    }

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
    // A link sent before end-to-end encryption was turned on: resetting now
    // would lose the vault's keys (see requestPasswordReset).
    if (user.e2eEnabled) {
      await user.update({ passwordResetTokenHash: null, passwordResetExpires: null });
      throw new Error(MASTER_RESET_REFUSED);
    }

    await user.update({
      password,
      passwordResetTokenHash: null,
      passwordResetExpires: null,
    });
    // Passkey unlock copies of the old user key go with it.
    await UserPasskey.update({ prfUserKey: null }, { where: { userId: user.id } });
    await SessionService.revokeAll(user.id);
    return user.id;
  }

  static revokeSession(refreshToken?: string) {
    return SessionService.revokeByToken(refreshToken, "web");
  }
}

export default AuthService;
