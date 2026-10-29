import bcrypt from "bcrypt";
import crypto from "crypto";
import EnvVars from "../common/EnvVars";
import CollectionKey from "../models/CollectionKey";
import { MemberRecovery } from "../models/CompanyRecovery";
import ItemKey from "../models/ItemKey";
import User from "../models/User";
import UserPasskey from "../models/UserPasskey";
import SessionService from "./SessionService";

/**
 * Accounts with end-to-end encryption (E2E_DESIGN.md, stage 10.2). The
 * browser makes every key from the master password; this service only stores
 * locked (wrapped) values and checks the derived sign-in key. It never sees
 * the master password or anything that opens the vault.
 */

/**
 * When every account must have end-to-end encryption on (stage 10.6), from
 * E2E_DEADLINE (an ISO date). Before it the app asks; after it, it insists.
 */
export function e2eDeadline(): string | null {
  const value = String(process.env.E2E_DEADLINE || "").trim();
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export class E2EError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface KdfParams {
  algorithm: "argon2id";
  memory: number;
  iterations: number;
  parallelism: number;
}

// Same floor as the browser's core: never store settings that make guessing cheap.
const MIN_KDF = { memory: 32 * 1024, iterations: 2 };
const B64URL = /^[A-Za-z0-9_-]+$/;
const WRAPPED = /^e2e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,400}$/;

const checkKdf = (input: any): KdfParams => {
  const params = {
    algorithm: input?.algorithm,
    memory: Number(input?.memory),
    iterations: Number(input?.iterations),
    parallelism: Number(input?.parallelism),
  };
  if (
    params.algorithm !== "argon2id" ||
    !Number.isInteger(params.memory) ||
    params.memory < MIN_KDF.memory ||
    params.memory > 1024 * 1024 ||
    !Number.isInteger(params.iterations) ||
    params.iterations < MIN_KDF.iterations ||
    params.iterations > 20 ||
    !Number.isInteger(params.parallelism) ||
    params.parallelism < 1 ||
    params.parallelism > 16
  ) {
    throw new E2EError("Those key settings aren't allowed.");
  }
  return params as KdfParams;
};

const checkSalt = (salt: unknown) => {
  const value = String(salt || "");
  if (!B64URL.test(value) || value.length < 22 || value.length > 64) {
    throw new E2EError("Bad key settings.");
  }
  return value;
};

/** A base64url secret of 32 bytes: the sign-in key or the recovery proof. */
const checkSecret = (value: unknown, name: string) => {
  const text = String(value || "");
  if (!B64URL.test(text) || text.length !== 43) throw new E2EError(`Bad ${name}.`);
  return text;
};

const checkWrapped = (value: unknown, name: string) => {
  const text = String(value || "");
  if (!WRAPPED.test(text)) throw new E2EError(`Bad ${name}.`);
  return text;
};

const checkPublicKey = (value: unknown) => {
  const text = String(value || "");
  if (!B64URL.test(text) || text.length !== 43) throw new E2EError("Bad public key.");
  return text;
};

const hash = async (value: string) => bcrypt.hash(value, await bcrypt.genSalt(10));

// What an unknown email gets from prelogin: the default settings and a salt
// that's the same every time for that email, so the answer doesn't tell
// whether an account exists.
const DEFAULT_KDF: KdfParams = { algorithm: "argon2id", memory: 64 * 1024, iterations: 3, parallelism: 1 };

const madeUpSalt = (email: string) =>
  crypto
    .createHmac("sha256", EnvVars.Jwt.Secret || "2keevo")
    .update(`2keevo/prelogin/v1|${email.trim().toLowerCase()}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");

class E2EAccountService {
  /**
   * What the browser needs before signing in. Unknown emails get made-up
   * settings, answered like an end-to-end account (the sign-in then fails as
   * any wrong password does). Only accounts that haven't turned end-to-end
   * encryption on yet answer `e2e: false`.
   */
  async prelogin(email: string) {
    const address = String(email || "").trim();
    if (!address) return { e2e: false };
    const user = await User.findOne({
      where: { email: address },
      attributes: ["id", "e2eEnabled", "kdfSalt", "kdfParams"],
    });
    if (!user) return { e2e: true, kdf: { ...DEFAULT_KDF, salt: madeUpSalt(address) } };
    if (!user.e2eEnabled || !user.kdfSalt || !user.kdfParams) return { e2e: false };
    return { e2e: true, kdf: { ...user.kdfParams, salt: user.kdfSalt } };
  }

  /** The locked keys, for opening the vault after sign-in or unlock. */
  bundle(user: User) {
    if (!user.e2eEnabled) return null;
    return {
      kdf: { ...(user.kdfParams || {}), salt: user.kdfSalt },
      protectedUserKey: user.protectedUserKey,
      publicKey: user.publicKey,
      protectedPrivateKey: user.protectedPrivateKey,
    };
  }

  /**
   * Turn it on. The current password proves it's the owner; from now on the
   * server checks the derived sign-in key instead and forgets the password.
   */
  /** The keys made in the browser, checked: what an end-to-end account stores. */
  async checkedBundle(input: any) {
    return {
      kdfParams: checkKdf(input?.kdf),
      kdfSalt: checkSalt(input?.kdf?.salt),
      password: checkSecret(input?.authKey, "sign-in key"),
      protectedUserKey: checkWrapped(input?.protectedUserKey, "vault key"),
      publicKey: checkPublicKey(input?.publicKey),
      protectedPrivateKey: checkWrapped(input?.protectedPrivateKey, "private key"),
      recoveryProtectedUserKey: checkWrapped(input?.recoveryProtectedUserKey, "recovery copy"),
      recoveryAuthHash: await hash(checkSecret(input?.recoveryAuth, "recovery proof")),
    };
  }

  async enable(user: User, input: any) {
    if (user.e2eEnabled) throw new E2EError("End-to-end encryption is already on.");
    const current = String(input?.password || "");
    if (!current || !(await user.comparePassword(current))) {
      throw new E2EError("Your current password isn't right.", 401);
    }
    const values = await this.checkedBundle(input);
    await user.update({ ...values, e2eEnabled: true, e2eSince: new Date() });
    // New keys: copies made for any earlier ones can't be opened. Without them,
    // the key tasks make new ones (shares, collection keys, company recovery).
    await UserPasskey.update({ prfUserKey: null }, { where: { userId: user.id } });
    await CollectionKey.destroy({ where: { userId: user.id } });
    await ItemKey.destroy({ where: { containerType: "user", containerId: user.id } });
    await MemberRecovery.destroy({ where: { userId: user.id } });
  }

  private async proveMasterPassword(user: User, authKey: unknown) {
    if (!user.e2eEnabled) throw new E2EError("End-to-end encryption isn't on.");
    const key = checkSecret(authKey, "sign-in key");
    if (!(await user.comparePassword(key))) {
      throw new E2EError("Your master password isn't right.", 401);
    }
  }

  /** New master password: the vault key is re-locked, nothing else changes. */
  async changeMasterPassword(user: User, sessionId: number | undefined, input: any) {
    await this.proveMasterPassword(user, input?.currentAuthKey);
    await user.update({
      kdfParams: checkKdf(input?.kdf),
      kdfSalt: checkSalt(input?.kdf?.salt),
      password: checkSecret(input?.authKey, "sign-in key"),
      protectedUserKey: checkWrapped(input?.protectedUserKey, "vault key"),
      mustChangeMasterPassword: false,
    });
    // Other devices signed in with the old password sign in again.
    await SessionService.revokeAll(user.id, sessionId);
  }

  /**
   * A company admin reset this member's master password (admin recovery): the
   * user key, opened in the admin's browser, locked again with a temporary
   * master password. The member must choose their own at next sign-in.
   */
  async resetByCompany(user: User, input: any) {
    if (!user.e2eEnabled) throw new E2EError("End-to-end encryption isn't on for this person.");
    await user.update({
      kdfParams: checkKdf(input?.kdf),
      kdfSalt: checkSalt(input?.kdf?.salt),
      password: checkSecret(input?.authKey, "sign-in key"),
      protectedUserKey: checkWrapped(input?.protectedUserKey, "vault key"),
      mustChangeMasterPassword: true,
    });
    await SessionService.revokeAll(user.id);
  }

  /** A new recovery key replaces the old one, which stops working. */
  async replaceRecoveryKey(user: User, input: any) {
    await this.proveMasterPassword(user, input?.authKey);
    await user.update({
      recoveryProtectedUserKey: checkWrapped(input?.recoveryProtectedUserKey, "recovery copy"),
      recoveryAuthHash: await hash(checkSecret(input?.recoveryAuth, "recovery proof")),
    });
  }

  private async recoveryUser(email: unknown, recoveryAuth: unknown) {
    const proof = checkSecret(recoveryAuth, "recovery key");
    const user = await User.findOne({ where: { email: String(email || "").trim() } });
    const ok =
      !!user?.e2eEnabled &&
      !!user.recoveryAuthHash &&
      (await bcrypt.compare(proof, user.recoveryAuthHash));
    if (!ok || !user) throw new E2EError("That email and recovery key don't match.", 401);
    return user;
  }

  /** Step 1 of recovery: the recovery copy of the vault key, for the browser to open. */
  async recoveryStart(email: unknown, recoveryAuth: unknown) {
    const user = await this.recoveryUser(email, recoveryAuth);
    return { recoveryProtectedUserKey: user.recoveryProtectedUserKey };
  }

  /** Step 2: a new master password, set with the vault key the recovery key opened. */
  async recoveryComplete(input: any) {
    const user = await this.recoveryUser(input?.email, input?.recoveryAuth);
    await user.update({
      kdfParams: checkKdf(input?.kdf),
      kdfSalt: checkSalt(input?.kdf?.salt),
      password: checkSecret(input?.authKey, "sign-in key"),
      protectedUserKey: checkWrapped(input?.protectedUserKey, "vault key"),
    });
    await SessionService.revokeAll(user.id);
    return user;
  }
}

export default new E2EAccountService();
