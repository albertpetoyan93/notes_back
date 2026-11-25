import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Op, Transaction } from "sequelize";
import EnvVars from "../common/EnvVars";
import User from "../models/User";
import UserSession, { SessionKind } from "../models/UserSession";
import CompanyPolicyService from "./CompanyPolicyService";
import AuditService from "./AuditService";

/**
 * A rotated refresh token keeps working this long, so tabs (which share the
 * cookie) or the extension's popup and background, refreshing at the same
 * moment, don't sign each other out. After that, using it again ends the sign-in.
 */
const ROTATION_GRACE_MS = 30 * 1000;

/** Staff sessions end after 30 minutes without use, and 12 hours after sign-in. */
export const ADMIN_IDLE_MS = 30 * 60 * 1000;
export const ADMIN_MAX_MS = 12 * 60 * 60 * 1000;

/**
 * A vault app sign-in ends after 12 hours without use (F18; owner's decision
 * 20 Nov: counted from the last real input, not from sign-in). The extension
 * keeps 7 days: it locks on its own timer and unlocking needs the master password.
 */
export const WEB_IDLE_MS = 12 * 60 * 60 * 1000;
export const EXTENSION_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function adminSessionUsable(
  s: { createdAt: Date; lastActiveAt: Date | null },
  now: number
): boolean {
  const created = new Date(s.createdAt).getTime();
  // No recorded activity yet: count idle time from sign-in.
  const lastActive = s.lastActiveAt ? new Date(s.lastActiveAt).getTime() : created;
  return now - created <= ADMIN_MAX_MS && now - lastActive <= ADMIN_IDLE_MS;
}

/** Why a refresh token was refused. Logged, and sent back so the browser shows it. */
export class RefreshError extends Error {
  constructor(public reason: string, public detail: Record<string, unknown> = {}) {
    super("Invalid refresh token");
  }
}

/** Allowed auto-lock times in minutes; 0 = never. */
export const AUTO_LOCK_CHOICES = [0, 5, 15, 30, 60, 120, 240, 360, 480, 600, 720, 1440];

/** The browser extension has its own list, from 5 minutes up to 12 hours. */
export const EXTENSION_AUTO_LOCK_CHOICES = [0, 5, 15, 30, 60, 180, 360, 480, 600, 720];

// The vault app sends activity at most once a minute, so allow a little more.
const ACTIVITY_SLACK_MS = 90 * 1000;

export interface SessionState {
  active: boolean;
  locked: boolean;
  /** Null when there is no usable session. */
  kind: SessionKind | null;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
  extensionVersion?: string | null;
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

function lifetime(kind: SessionKind) {
  if (kind === "admin") return ADMIN_MAX_MS;
  return kind === "web" ? WEB_IDLE_MS : EXTENSION_SESSION_MS;
}

function expiry(kind: SessionKind) {
  return new Date(Date.now() + lifetime(kind));
}

type AccessType = "access" | "admin_access";

/** Admin sessions get their own token type, so vault routes never accept them. */
function accessType(kind: SessionKind): AccessType {
  return kind === "admin" ? "admin_access" : "access";
}

function metaFields(meta: SessionMeta) {
  return {
    userAgent: meta.userAgent ? meta.userAgent.slice(0, 500) : null,
    ip: meta.ip ? meta.ip.slice(0, 100) : null,
    // Only touch the column when the caller set it (extension traffic).
    ...(meta.extensionVersion !== undefined
      ? { extensionVersion: meta.extensionVersion ? meta.extensionVersion.slice(0, 32) : null }
      : {}),
  };
}

/** Every kind of sign-in and refresh goes through here, so one check covers them all. */
async function refuseSuspended(userId: number) {
  const user = await User.findByPk(userId, { attributes: ["suspendedAt"] });
  if (user?.suspendedAt) {
    throw Object.assign(new Error("This account is suspended. Contact support."), { status: 403, code: "suspended" });
  }
}

class SessionService {
  static async create(
    userId: number,
    kind: SessionKind,
    meta: SessionMeta
  ): Promise<SessionTokens> {
    await refuseSuspended(userId);
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
      expiresAt: expiry(kind),
      ...metaFields(meta),
    });

    return {
      accessToken: this.signAccessToken(userId, session.id, accessType(kind)),
      refreshToken: this.signRefreshToken(userId, session.id, tokenId, kind),
      sessionId: session.id,
    };
  }

  /**
   * Exchange a refresh token for new tokens. The presented token stops working,
   * except for a short grace period (see ROTATION_GRACE_MS).
   */
  static async rotate(
    refreshToken: string | undefined,
    kind: SessionKind,
    meta: SessionMeta
  ): Promise<SessionTokens> {
    const payload = this.readRefreshPayload(refreshToken);

    if (!payload.sid) {
      // Admin sessions never had legacy tokens.
      if (kind === "admin") throw new RefreshError("legacy_token", { userId: payload.userId });
      return this.upgradeLegacy(payload, kind, meta);
    }

    const session = await UserSession.findOne({
      where: { id: payload.sid, userId: payload.userId, kind },
    });
    if (!session) throw new RefreshError("no_session", { sid: payload.sid, userId: payload.userId });
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      throw new RefreshError("session_expired", { sid: session.id, expiresAt: session.expiresAt });
    }
    if (
      kind === "admin" &&
      !adminSessionUsable(
        { createdAt: session.createdAt, lastActiveAt: session.lastActiveAt ?? null },
        Date.now()
      )
    ) {
      throw new RefreshError("session_expired", { sid: session.id, kind });
    }
    if (kind === "web") {
      // Real input only (touch/unlock); a locked tab polling in the background doesn't count.
      const lastUse = new Date(session.lastActiveAt ?? session.createdAt).getTime();
      if (Date.now() - lastUse > WEB_IDLE_MS) {
        await session.destroy();
        throw new RefreshError("idle_signed_out", { sid: session.id });
      }
    }
    await refuseSuspended(session.userId);
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
        // An admin session ends 12 hours after sign-in, however often it refreshes.
        ...(kind === "admin" ? {} : { expiresAt: expiry(kind) }),
        ...metaFields(meta),
      },
      { where: { id: session.id, tokenHash: presented } }
    );

    if (rotated === 1) {
      return {
        accessToken: this.signAccessToken(session.userId, session.id, accessType(kind)),
        refreshToken: this.signRefreshToken(session.userId, session.id, tokenId, kind),
        sessionId: session.id,
      };
    }

    // Two parts of one browser refreshing at once (tabs share the cookie; the
    // extension's popup and background each refresh): the second one in.
    await session.reload();
    const rotatedAt = session.rotatedAt ? new Date(session.rotatedAt).getTime() : 0;
    const previous = session.previousTokenHash === presented;
    if (previous && Date.now() - rotatedAt < ROTATION_GRACE_MS) {
      return {
        accessToken: this.signAccessToken(session.userId, session.id, accessType(kind)),
        // The newest refresh token is already with the browser / extension.
        refreshToken: null,
        sessionId: session.id,
      };
    }

    // An old refresh token used again: someone may have copied it (F18, SEC05).
    // End this sign-in on every copy, and always tell the owner. The last token
    // again from the same device is most likely a lost answer (popup closed
    // mid-refresh), so the log says so instead of sounding the alarm.
    const sameDevice =
      previous &&
      !!meta.ip &&
      meta.ip.slice(0, 100) === session.ip &&
      (meta.userAgent ?? "").slice(0, 500) === (session.userAgent ?? "");
    // Logged first: record() never throws, destroy() can.
    await AuditService.record({
      actorId: session.userId,
      action: "session_token_reused",
      details: sameDevice ? { kind, likelyLostAnswer: true } : { kind },
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await session.destroy();
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
      if (kind === "admin") return;

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
    if (!session) return { active: false, locked: false, kind: null };
    const { kind } = session;
    if (kind !== "web") return { active: true, locked: false, kind };
    if (session.lockedAt) return { active: true, locked: true, kind };

    const lastActive = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
    if (
      autoLockMinutes > 0 &&
      lastActive &&
      Date.now() - lastActive > autoLockMinutes * 60 * 1000 + ACTIVITY_SLACK_MS
    ) {
      await session.update({ lockedAt: new Date() });
      return { active: true, locked: true, kind };
    }
    return { active: true, locked: false, kind };
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

  /** Remember the extension build on this session (fire-and-forget from isAuth). */
  static noteExtensionVersion(sessionId: number, userId: number, version: string) {
    void UserSession.update(
      { extensionVersion: version.slice(0, 32) },
      { where: { id: sessionId, userId, kind: "extension" } }
    ).catch(() => undefined);
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
  static async revokeAll(userId: number, exceptSessionId?: number, transaction?: Transaction) {
    await UserSession.destroy({
      where: exceptSessionId
        ? { userId, id: { [Op.ne]: exceptSessionId } }
        : { userId },
      transaction,
    });
    await User.update(
      { refreshTokenId: null, extensionRefreshTokenId: null },
      { where: { id: userId }, transaction }
    );
  }

  /** Sign out the vault app and the extension only; staff stay signed in to the admin app. */
  static async revokeKinds(userId: number, kinds: Exclude<SessionKind, "admin">[]) {
    await UserSession.destroy({ where: { userId, kind: { [Op.in]: kinds } } });
    await User.update(
      {
        ...(kinds.includes("web") ? { refreshTokenId: null } : {}),
        ...(kinds.includes("extension") ? { extensionRefreshTokenId: null } : {}),
      },
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

  private static signAccessToken(userId: number, sid: number, type: AccessType = "access") {
    return jwt.sign({ userId, type, sid }, EnvVars.Jwt.Secret, {
      expiresIn: "15m",
    });
  }

  private static signRefreshToken(userId: number, sid: number, jti: string, kind: SessionKind) {
    return jwt.sign({ userId, type: "refresh", sid, jti }, EnvVars.Jwt.Secret, {
      expiresIn: Math.round(lifetime(kind) / 1000),
    });
  }
}

export default SessionService;
