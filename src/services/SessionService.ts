import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Op } from "sequelize";
import EnvVars from "../common/EnvVars";
import User from "../models/User";
import UserSession, { SessionKind } from "../models/UserSession";
import CompanyPolicyService from "./CompanyPolicyService";
import { REFRESH_MAX_AGE_MS } from "../util/authCookies";

/**
 * A rotated web refresh token keeps working this long, so tabs that refresh at
 * the same moment do not sign each other out (the browser shares the cookie).
 */
const ROTATION_GRACE_MS = 30 * 1000;

/** Why a refresh token was refused. Logged, and sent back so the browser shows it. */
export class RefreshError extends Error {
  constructor(public reason: string, public detail: Record<string, unknown> = {}) {
    super("Invalid refresh token");
  }
}

/** Allowed auto-lock times in minutes; 0 = never. */
export const AUTO_LOCK_CHOICES = [0, 5, 15, 30, 60];

// The vault app sends activity at most once a minute, so allow a little more.
const ACTIVITY_SLACK_MS = 90 * 1000;

export interface SessionState {
  active: boolean;
  locked: boolean;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface SessionTokens {
  accessToken: string;
  /** Null when the browser already holds the newest refresh token. */
  refreshToken: string | null;
  sessionId: number;
}

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function newTokenId() {
  return crypto.randomBytes(32).toString("hex");
}

function expiry() {
  return new Date(Date.now() + REFRESH_MAX_AGE_MS);
}

function metaFields(meta: SessionMeta) {
  return {
    userAgent: meta.userAgent ? meta.userAgent.slice(0, 500) : null,
    ip: meta.ip ? meta.ip.slice(0, 100) : null,
  };
}

class SessionService {
  static async create(
    userId: number,
    kind: SessionKind,
    meta: SessionMeta
  ): Promise<SessionTokens> {
    await UserSession.destroy({
      where: { userId, expiresAt: { [Op.lt]: new Date() } },
    });

    const tokenId = newTokenId();
    const session = await UserSession.create({
      userId,
      kind,
      tokenHash: hash(tokenId),
      lastUsedAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: expiry(),
      ...metaFields(meta),
    });

    return {
      accessToken: this.signAccessToken(userId, session.id),
      refreshToken: this.signRefreshToken(userId, session.id, tokenId),
      sessionId: session.id,
    };
  }

  /**
   * Exchange a refresh token for new tokens. The presented token stops working,
   * except for a short grace period on the web (see ROTATION_GRACE_MS).
   */
  static async rotate(
    refreshToken: string | undefined,
    kind: SessionKind,
    meta: SessionMeta
  ): Promise<SessionTokens> {
    const payload = this.readRefreshPayload(refreshToken);

    if (!payload.sid) {
      return this.upgradeLegacy(payload, kind, meta);
    }

    const session = await UserSession.findOne({
      where: { id: payload.sid, userId: payload.userId, kind },
    });
    if (!session) throw new RefreshError("no_session", { sid: payload.sid, userId: payload.userId });
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      throw new RefreshError("session_expired", { sid: session.id, expiresAt: session.expiresAt });
    }
    // A company policy can limit how old a sign-in may get.
    const { maxSessionDays } = await CompanyPolicyService.forUser(session.userId);
    if (
      maxSessionDays &&
      Date.now() - new Date(session.createdAt).getTime() > maxSessionDays * 24 * 60 * 60 * 1000
    ) {
      await session.destroy();
      throw new RefreshError("max_session_days", { sid: session.id, maxSessionDays });
    }

    const presented = hash(payload.jti);
    const tokenId = newTokenId();
    // Conditional update: of two requests with the same token only one rotates.
    const [rotated] = await UserSession.update(
      {
        tokenHash: hash(tokenId),
        previousTokenHash: presented,
        rotatedAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt: expiry(),
        ...metaFields(meta),
      },
      { where: { id: session.id, tokenHash: presented } }
    );

    if (rotated === 1) {
      return {
        accessToken: this.signAccessToken(session.userId, session.id),
        refreshToken: this.signRefreshToken(session.userId, session.id, tokenId),
        sessionId: session.id,
      };
    }

    if (kind === "web") {
      await session.reload();
      const rotatedAt = session.rotatedAt
        ? new Date(session.rotatedAt).getTime()
        : 0;
      if (
        session.previousTokenHash === presented &&
        Date.now() - rotatedAt < ROTATION_GRACE_MS
      ) {
        return {
          accessToken: this.signAccessToken(session.userId, session.id),
          refreshToken: null,
          sessionId: session.id,
        };
      }
    }

    throw new RefreshError("token_reused", {
      sid: session.id,
      previousMatches: session.previousTokenHash === presented,
      secondsSinceRotation: session.rotatedAt ? Math.round((Date.now() - new Date(session.rotatedAt).getTime()) / 1000) : null,
    });
  }

  static async revokeByToken(refreshToken: string | undefined, kind: SessionKind) {
    if (!refreshToken) return;

    try {
      const payload = this.readRefreshPayload(refreshToken);
      if (payload.sid) {
        await UserSession.destroy({
          where: { id: payload.sid, userId: payload.userId, kind },
        });
        return;
      }

      const user = await User.findByPk(payload.userId);
      const field = kind === "web" ? "refreshTokenId" : "extensionRefreshTokenId";
      if (user && user[field] === payload.jti) {
        await user.update({ [field]: null });
      }
    } catch {
      return;
    }
  }

  /**
   * Whether a session may be used, and whether it is locked. A web session
   * that has seen no input for longer than the user's auto-lock time is
   * locked here, so it stays locked even after the laptop wakes up.
   */
  static async state(
    sessionId: number,
    userId: number,
    autoLockMinutes: number
  ): Promise<SessionState> {
    const session = await UserSession.findOne({
      where: { id: sessionId, userId, expiresAt: { [Op.gt]: new Date() } },
      attributes: ["id", "kind", "lastActiveAt", "lockedAt"],
    });
    if (!session) return { active: false, locked: false };
    if (session.kind !== "web") return { active: true, locked: false };
    if (session.lockedAt) return { active: true, locked: true };

    const lastActive = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
    if (
      autoLockMinutes > 0 &&
      lastActive &&
      Date.now() - lastActive > autoLockMinutes * 60 * 1000 + ACTIVITY_SLACK_MS
    ) {
      await session.update({ lockedAt: new Date() });
      return { active: true, locked: true };
    }
    return { active: true, locked: false };
  }

  static async lock(sessionId: number, userId: number) {
    await UserSession.update(
      { lockedAt: new Date() },
      { where: { id: sessionId, userId, kind: "web", lockedAt: null } }
    );
  }

  static async unlock(sessionId: number, userId: number) {
    await UserSession.update(
      { lockedAt: null, lastActiveAt: new Date() },
      { where: { id: sessionId, userId } }
    );
  }

  /** The person used the vault (input in the page). Ignored while locked. */
  static async touch(sessionId: number, userId: number) {
    await UserSession.update(
      { lastActiveAt: new Date() },
      { where: { id: sessionId, userId, lockedAt: null } }
    );
  }

  static async isActive(sessionId: number, userId: number) {
    const count = await UserSession.count({
      where: { id: sessionId, userId, expiresAt: { [Op.gt]: new Date() } },
    });
    return count > 0;
  }

  static async list(userId: number) {
    return UserSession.findAll({
      where: { userId, expiresAt: { [Op.gt]: new Date() } },
      attributes: ["id", "kind", "userAgent", "ip", "lastUsedAt", "createdAt"],
      order: [["lastUsedAt", "DESC"]],
    });
  }

  static async revoke(userId: number, sessionId: number) {
    return UserSession.destroy({ where: { id: sessionId, userId } });
  }

  /** Sign out every device, optionally keeping the one making the request. */
  static async revokeAll(userId: number, exceptSessionId?: number) {
    await UserSession.destroy({
      where: exceptSessionId
        ? { userId, id: { [Op.ne]: exceptSessionId } }
        : { userId },
    });
    await User.update(
      { refreshTokenId: null, extensionRefreshTokenId: null },
      { where: { id: userId } }
    );
  }

  /**
   * Tokens issued before per-device sessions carry no session id. Accept them
   * once (they still have to match the user's stored id) and move them over.
   */
  private static async upgradeLegacy(
    payload: jwt.JwtPayload & { userId: number; jti: string },
    kind: SessionKind,
    meta: SessionMeta
  ) {
    const user = await User.findByPk(payload.userId);
    const field = kind === "web" ? "refreshTokenId" : "extensionRefreshTokenId";
    if (!user || !user[field] || user[field] !== payload.jti) {
      throw new RefreshError("legacy_token", { userId: payload.userId });
    }

    await user.update({ [field]: null });
    return this.create(user.id, kind, meta);
  }

  private static readRefreshPayload(refreshToken?: string) {
    if (!refreshToken) {
      throw new RefreshError("no_cookie");
    }

    let payload: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(refreshToken, EnvVars.Jwt.Secret);
      if (typeof decoded === "string") {
        throw new RefreshError("bad_token");
      }
      payload = decoded;
    } catch (error: any) {
      throw new RefreshError(error?.name === "TokenExpiredError" ? "token_expired" : "bad_token");
    }

    if (payload.type !== "refresh" || !payload.userId || !payload.jti) {
      throw new RefreshError("not_refresh");
    }

    return payload as jwt.JwtPayload & { userId: number; jti: string };
  }

  private static signAccessToken(userId: number, sid: number) {
    return jwt.sign({ userId, type: "access", sid }, EnvVars.Jwt.Secret, {
      expiresIn: "15m",
    });
  }

  private static signRefreshToken(userId: number, sid: number, jti: string) {
    return jwt.sign({ userId, type: "refresh", sid, jti }, EnvVars.Jwt.Secret, {
      expiresIn: "7d",
    });
  }
}

export default SessionService;
