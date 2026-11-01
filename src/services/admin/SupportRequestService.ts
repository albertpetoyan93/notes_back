import crypto from "crypto";
import type { Request } from "express";
import logger from "jet-logger";
import { Op, Transaction } from "sequelize";
import EnvVars from "../../common/EnvVars";
import sequelize from "../../configs/DB/sequelize";
import SupportRequest from "../../models/SupportRequest";
import User from "../../models/User";
import AuditService from "../AuditService";
import CompanyPolicyService from "../CompanyPolicyService";
import EmailService from "../EmailService";
import SessionService from "../SessionService";
import AdminActionService, { assertConfirmEmail, cleanReason } from "./AdminActionService";
import { actor, Staff, tellUser } from "./SupportActionService";

const DAY_MS = 24 * 60 * 60 * 1000;
const LINK_GONE = "This link has expired or was already used. Contact support for a new one.";

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Only a pending row moves, so a request that was decided meanwhile stays as it is. */
const markExpired = (id: number, transaction?: Transaction) =>
  SupportRequest.update({ status: "expired" }, { where: { id, status: "pending" }, transaction });

/** Logged after the change is saved: a failure here must not undo or hide it. */
async function quietly(what: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    logger.err(`${what}: ${error}`);
  }
}

/**
 * Support asks, the user decides: 2FA is only removed when the account's own
 * email link is confirmed. Only the token's hash is stored.
 */
class SupportRequestService {
  static async requestTwoFactorRemoval(
    staff: Staff,
    userId: number,
    reason: unknown,
    confirmEmail: unknown,
    req: Request
  ): Promise<{ id: number; expiresAt: Date }> {
    const why = cleanReason(reason);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + DAY_MS);
    // One transaction: a request is never left without its AdminAction.
    const { user, request } = await sequelize.transaction(async (transaction) => {
      // The user row is locked first, so two staff asking at once take turns
      // and the second one sees the first one's waiting request.
      const user = await User.findByPk(userId, {
        attributes: ["id", "email", "twoFactorEnabled"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!user) throw fail(404, "User not found.");
      assertConfirmEmail(confirmEmail, user.email);
      if (!user.twoFactorEnabled) throw fail(409, "Two-step sign-in is already off.");
      const waiting = await SupportRequest.findOne({
        where: { userId: user.id, kind: "remove_2fa", status: "pending" },
        attributes: ["id", "expiresAt"],
        transaction,
      });
      if (waiting) {
        if (waiting.expiresAt.getTime() > Date.now()) throw fail(409, "A request is already waiting for the user.");
        await markExpired(waiting.id, transaction);
      }

      const request = await SupportRequest.create(
        {
          kind: "remove_2fa",
          userId: user.id,
          requestedBy: staff.userId,
          reason: why,
          tokenHash: hashToken(token),
          expiresAt,
        },
        { transaction }
      );
      await AdminActionService.record({
        staff: actor(staff),
        action: "remove_2fa_requested",
        targetUserId: user.id,
        reason: why,
        details: { requestId: request.id },
        req,
        transaction,
      });
      return { user, request };
    });

    await AuditService.record({
      actorId: user.id,
      action: "support_action",
      details: { what: "2keevo support asked to turn off two-step sign-in. Check your email to confirm." },
    });
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/auth/confirm-support?token=${encodeURIComponent(token)}`;
    // The request stands even if the email fails; support can cancel and ask again.
    await quietly("Remove 2FA email", () =>
      EmailService.sendRemoveTwoFactorConfirm({ to: user.email, link, expiresAt })
    );
    return { id: request.id, expiresAt };
  }

  static async cancel(staff: Staff, requestId: number, reason: unknown, req: Request) {
    const why = cleanReason(reason);
    const request = await SupportRequest.findByPk(requestId, { attributes: ["id", "userId", "status"] });
    if (!request) throw fail(404, "Request not found.");
    if (request.status !== "pending") throw fail(409, "Only a waiting request can be cancelled.");

    const [changed] = await SupportRequest.update(
      { status: "cancelled", decidedAt: new Date() },
      { where: { id: request.id, status: "pending" } }
    );
    if (!changed) throw fail(409, "Only a waiting request can be cancelled.");
    await AdminActionService.record({
      staff: actor(staff),
      action: "remove_2fa_cancelled",
      targetUserId: request.userId,
      reason: why,
      details: { requestId: request.id },
      req,
    });
  }

  /** The user clicked the button on the emailed link. Every refusal looks the same. */
  static async confirm(token: string): Promise<{ ok: true }> {
    if (typeof token !== "string" || !token) throw fail(410, LINK_GONE);
    const request = await SupportRequest.findOne({
      where: { tokenHash: hashToken(token), kind: "remove_2fa" },
      attributes: ["id", "userId", "status", "expiresAt"],
    });
    if (!request || request.status !== "pending") throw fail(410, LINK_GONE);
    if (request.expiresAt.getTime() <= Date.now()) {
      await markExpired(request.id);
      throw fail(410, LINK_GONE);
    }

    await sequelize.transaction(async (transaction) => {
      const now = new Date();
      // Claims the row first: a second click waits here, then finds nothing to claim.
      const [claimed] = await SupportRequest.update(
        { status: "confirmed", decidedAt: now },
        { where: { id: request.id, status: "pending", expiresAt: { [Op.gt]: now } }, transaction }
      );
      if (!claimed) throw fail(410, LINK_GONE);
      await User.update(
        { twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: null, twoFactorLastStep: null },
        { where: { id: request.userId }, transaction }
      );
      await SessionService.revokeAll(request.userId, undefined, transaction);
    });
    CompanyPolicyService.clear(request.userId);

    await quietly("remove_2fa_confirmed", () =>
      AdminActionService.record({
        staff: null,
        action: "remove_2fa_confirmed",
        targetUserId: request.userId,
        details: { requestId: request.id },
      })
    );
    await quietly("Remove 2FA notice", async () => {
      const user = await User.findByPk(request.userId, { attributes: ["id", "email"] });
      if (user) await tellUser(user, "2keevo support turned off two-step sign-in after you confirmed.");
    });
    await quietly("two_factor_disabled", () =>
      AuditService.record({ actorId: request.userId, action: "two_factor_disabled" })
    );
    return { ok: true };
  }
}

export default SupportRequestService;
