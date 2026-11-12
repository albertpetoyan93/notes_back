import crypto from "crypto";
import logger from "jet-logger";
import { Op } from "sequelize";
import EnvVars from "../common/EnvVars";
import AdminStaff from "../models/AdminStaff";
import Collection from "../models/Collection";
import CompanyMember from "../models/CompanyMember";
import SecretLink from "../models/SecretLink";
import SupportRequest from "../models/SupportRequest";
import EmergencyContact from "../models/EmergencyContact";
import FamilyMember from "../models/FamilyMember";
import Note from "../models/Note";
import Subscription from "../models/Subscription";
import User from "../models/User";
import EmailService from "./EmailService";

/**
 * Email verification (F15). An account proves it owns its address before the
 * address gives it anything: company, family and emergency-contact invites,
 * being found by email for sharing. The link is single-use and lasts 24 h
 * (only its SHA-256 hash is stored). Unconfirmed accounts that never confirm
 * and have nothing are removed after 7 days, so nobody can hold an address
 * they don't own.
 */
const LINK_MS = 24 * 60 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const UNCONFIRMED_DAYS = 7;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const fail = (message: string, status: number) => Object.assign(new Error(message), { status });

class EmailVerificationService {
  isVerified(user: Pick<User, "emailVerifiedAt">) {
    return !!user.emailVerifiedAt;
  }

  /**
   * The account that owns this address, only once it has confirmed it: an
   * address gives nothing (invites, staff roles, shares) to an account that
   * hasn't proved it owns it. % and _ are matched literally.
   */
  async confirmedAccountByEmail(email: string, attributes: string[] = ["id", "email"]) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized) return null;
    return User.findOne({
      where: { email: { [Op.iLike]: normalized.replace(/[\\%_]/g, "\\$&") }, emailVerifiedAt: { [Op.not]: null } },
      attributes,
    });
  }

  /** Whether this account has confirmed its address (invites to the address wait until then). */
  async isVerifiedId(userId: number) {
    const user = await User.findByPk(userId, { attributes: ["id", "emailVerifiedAt"] });
    return !!user?.emailVerifiedAt;
  }

  /** A new link: any older one stops working. */
  async issue(user: User) {
    const token = crypto.randomBytes(32).toString("base64url");
    await user.update({ emailVerifyTokenHash: hashToken(token), emailVerifyExpires: new Date(Date.now() + LINK_MS) });
    if (!EmailService.isConfigured() && EnvVars.NodeEnv !== "production") {
      const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
      logger.info(`Email confirmation link for ${user.email}: ${origin}/auth/confirm-email?token=${token}`);
    }
    await EmailService.sendEmailConfirmation({ to: user.email, token }).catch((error) => logger.err(error, true));
  }

  /** The token decides which account is confirmed, not who is signed in. */
  async confirm(token: unknown) {
    const raw = String(token || "").trim();
    const user = raw ? await User.findOne({ where: { emailVerifyTokenHash: hashToken(raw) } }) : null;
    const expires = user?.emailVerifyExpires ? new Date(user.emailVerifyExpires).getTime() : 0;
    if (!user || expires < Date.now()) throw fail("This link is invalid or has expired.", 404);
    await user.update({ emailVerifiedAt: new Date(), emailVerifyTokenHash: null, emailVerifyExpires: null });
    return { email: user.email };
  }

  /** A company invite link (F15 token) proves the inbox too. */
  async markVerified(user: User) {
    if (!user.emailVerifiedAt) await user.update({ emailVerifiedAt: new Date(), emailVerifyTokenHash: null, emailVerifyExpires: null });
  }

  async resend(userId: number) {
    const user = await User.findByPk(userId);
    if (!user) throw fail("Unauthorized", 401);
    if (user.emailVerifiedAt) throw fail("Your email is already confirmed.", 409);
    // The last link was sent at its expiry minus its lifetime.
    const sentAt = user.emailVerifyExpires ? new Date(user.emailVerifyExpires).getTime() - LINK_MS : 0;
    if (Date.now() - sentAt < RESEND_MS) throw fail("We just sent a link. Wait a minute before asking again.", 429);
    await this.issue(user);
  }

  /** Unconfirmed for more than 7 days and nothing attached to them: removed. Returns how many. */
  async purgeUnconfirmed(now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - UNCONFIRMED_DAYS * 24 * 60 * 60 * 1000);
    const candidates = await User.findAll({
      where: { emailVerifiedAt: null, createdAt: { [Op.lt]: cutoff } },
      attributes: ["id", "email"],
    });
    let removed = 0;
    for (const user of candidates) {
      const has =
        (await CompanyMember.count({ where: { userId: user.id } })) +
        (await Note.count({ where: { userId: user.id }, paranoid: false })) +
        (await FamilyMember.count({ where: { [Op.or]: [{ ownerId: user.id }, { userId: user.id }] } })) +
        (await EmergencyContact.count({ where: { [Op.or]: [{ grantorId: user.id }, { contactId: user.id }] } })) +
        (await Subscription.count({ where: { userId: user.id } })) +
        // Deleted with the user (cascade), so they count as holding something too.
        (await AdminStaff.count({ where: { userId: user.id } })) +
        (await SupportRequest.count({ where: { userId: user.id } })) +
        (await SecretLink.count({ where: { createdBy: user.id } })) +
        (await Collection.count({ where: { userId: user.id }, paranoid: false }));
      if (has) continue;
      await User.destroy({ where: { id: user.id, emailVerifiedAt: null } });
      removed += 1;
    }
    return removed;
  }
}

export default new EmailVerificationService();
