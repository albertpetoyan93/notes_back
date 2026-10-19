import crypto from "crypto";
import sequelize from "../configs/DB/sequelize";
import User from "../models/User";
import { decrypt, encrypt } from "../util/encryption";
import { generateSecret, otpauthUrl, verifyCode } from "../util/totp";

const ISSUER = "2keevo";
const RECOVERY_CODE_COUNT = 10;
// No 0/o, 1/l/i so codes are easy to read off paper.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export class TwoFactorError extends Error {}

function hashRecoveryCode(code: string) {
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function newRecoveryCode() {
  const bytes = crypto.randomBytes(10);
  const chars = Array.from(
    bytes,
    (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
  ).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

function newRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

class TwoFactorService {
  static status(user: User) {
    return {
      enabled: Boolean(user.twoFactorEnabled),
      recoveryCodesLeft: user.twoFactorEnabled
        ? (user.twoFactorRecoveryCodes || []).length
        : 0,
    };
  }

  /** Start enrollment: a new secret that only becomes active after enable(). */
  static async setup(user: User) {
    if (user.twoFactorEnabled) {
      throw new TwoFactorError("Two-factor authentication is already on.");
    }

    const secret = generateSecret();
    await user.update({
      twoFactorSecret: encrypt(secret),
      twoFactorLastStep: null,
      twoFactorRecoveryCodes: null,
    });

    return { secret, otpauthUrl: otpauthUrl(secret, user.email, ISSUER) };
  }

  /** Confirm enrollment with a code from the app. Returns the recovery codes once. */
  static async enable(user: User, code: string) {
    if (user.twoFactorEnabled) {
      throw new TwoFactorError("Two-factor authentication is already on.");
    }
    if (!user.twoFactorSecret) {
      throw new TwoFactorError("Start the setup again.");
    }

    const step = verifyCode(decrypt(user.twoFactorSecret), code);
    if (step === null) {
      throw new TwoFactorError("That code is not valid. Try the newest one.");
    }

    const { codes, hashes } = newRecoveryCodes();
    await user.update({
      twoFactorEnabled: true,
      twoFactorLastStep: step,
      twoFactorRecoveryCodes: hashes,
    });
    return codes;
  }

  static async disable(user: User, password: string, code: string) {
    if (!user.twoFactorEnabled) {
      throw new TwoFactorError("Two-factor authentication is already off.");
    }
    if (!(await user.comparePassword(String(password || "")))) {
      throw new TwoFactorError("Wrong password.");
    }
    if (!(await this.verify(user.id, code))) {
      throw new TwoFactorError("That code is not valid.");
    }

    await User.update(
      {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorRecoveryCodes: null,
        twoFactorLastStep: null,
      },
      { where: { id: user.id } }
    );
  }

  static async regenerateRecoveryCodes(user: User, code: string) {
    if (!user.twoFactorEnabled) {
      throw new TwoFactorError("Two-factor authentication is off.");
    }
    if (!(await this.verify(user.id, code))) {
      throw new TwoFactorError("That code is not valid.");
    }

    const { codes, hashes } = newRecoveryCodes();
    await User.update(
      { twoFactorRecoveryCodes: hashes },
      { where: { id: user.id } }
    );
    return codes;
  }

  /**
   * Check a 6-digit app code or a recovery code. A used app code (its time
   * step) and a used recovery code are both burned. Row lock keeps two
   * requests with the same code from both passing.
   */
  static async verify(userId: number, code: string) {
    const given = String(code || "").trim();
    if (!given) return false;

    return sequelize.transaction(async (transaction) => {
      const user = await User.findByPk(userId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
        return false;
      }

      const digits = given.replace(/\s/g, "");
      if (/^\d{6}$/.test(digits)) {
        const step = verifyCode(
          decrypt(user.twoFactorSecret),
          digits,
          user.twoFactorLastStep
        );
        if (step === null) return false;
        await user.update({ twoFactorLastStep: step }, { transaction });
        return true;
      }

      const hashes = user.twoFactorRecoveryCodes || [];
      const index = hashes.indexOf(hashRecoveryCode(given));
      if (index === -1) return false;
      await user.update(
        { twoFactorRecoveryCodes: hashes.filter((_, i) => i !== index) },
        { transaction }
      );
      return true;
    });
  }
}

export default TwoFactorService;
