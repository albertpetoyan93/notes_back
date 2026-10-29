import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import EnvVars from "../common/EnvVars";
import User from "../models/User";
import UserPasskey from "../models/UserPasskey";

export class PasskeyError extends Error {}

const RP_NAME = "2keevo";
const MAX_PASSKEYS = 20;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type ChallengePurpose = "passkey_register" | "passkey_login";

// Every challenge is accepted once. One backend process (pm2, 1 instance), so memory is enough.
const usedChallenges = new Map<string, number>();

function rememberUsed(id: string) {
  const now = Date.now();
  for (const [key, expires] of usedChallenges) {
    if (expires < now) usedChallenges.delete(key);
  }
  if (usedChallenges.has(id)) return false;
  usedChallenges.set(id, now + CHALLENGE_TTL_MS);
  return true;
}

/** Sites allowed to use 2keevo passkeys: the same ones CORS allows. */
function origins() {
  return (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * The domain passkeys belong to. In production "2keevo.com", so one passkey works on
 * the website and on app.2keevo.com. Defaults to the first allowed origin's host.
 */
function rpId() {
  const configured = String(process.env.WEBAUTHN_RP_ID || "").trim();
  if (configured) return configured;
  try {
    return new URL(origins()[0]).hostname;
  } catch {
    return "localhost";
  }
}

// The user handle stored in a passkey: the user id, never their email.
function userHandle(userId: number) {
  return isoUint8Array.fromUTF8String(String(userId));
}

function signChallenge(purpose: ChallengePurpose, challenge: string, userId?: number) {
  return jwt.sign(
    { type: purpose, challenge, userId, jti: crypto.randomBytes(16).toString("hex") },
    EnvVars.Jwt.Secret,
    { expiresIn: CHALLENGE_TTL_MS / 1000 }
  );
}

function readChallenge(token: unknown, purpose: ChallengePurpose, userId?: number) {
  try {
    const decoded = jwt.verify(String(token || ""), EnvVars.Jwt.Secret);
    if (
      typeof decoded !== "string" &&
      decoded.type === purpose &&
      typeof decoded.challenge === "string" &&
      typeof decoded.jti === "string" &&
      (userId === undefined || decoded.userId === userId) &&
      rememberUsed(decoded.jti)
    ) {
      return decoded.challenge as string;
    }
  } catch {
    // Falls through to the error below.
  }
  throw new PasskeyError("This passkey request expired. Try again.");
}

function cleanName(name: unknown) {
  const text = String(name || "").trim().slice(0, 100);
  return text || "Passkey";
}

export function publicPasskey(passkey: UserPasskey) {
  return {
    id: passkey.id,
    name: passkey.name,
    synced: passkey.deviceType === "multiDevice" || passkey.backedUp,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt || null,
    // End-to-end accounts: this passkey also opens the vault (PRF).
    unlocksVault: !!passkey.prfUserKey,
  };
}

const WRAPPED_KEY = /^e2e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,100}$/;

class PasskeyService {
  static async list(userId: number) {
    const rows = await UserPasskey.findAll({
      where: { userId },
      order: [["createdAt", "ASC"]],
    });
    return rows.map(publicPasskey);
  }

  static count(userId: number) {
    return UserPasskey.count({ where: { userId } });
  }

  /** Step 1 of adding a passkey: what the browser needs to create one. */
  static async registrationOptions(user: User) {
    const existing = await UserPasskey.findAll({ where: { userId: user.id } });
    if (existing.length >= MAX_PASSKEYS) {
      throw new PasskeyError(`You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId(),
      userID: userHandle(user.id),
      userName: user.email,
      userDisplayName: user.fullName || user.username,
      attestationType: "none",
      // The browser refuses to make a second passkey on a device that already has one.
      excludeCredentials: existing.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });

    return {
      options,
      challengeToken: signChallenge("passkey_register", options.challenge, user.id),
    };
  }

  /** Step 2: check what the browser created and keep its public key. */
  static async register(
    user: User,
    challengeToken: unknown,
    response: RegistrationResponseJSON,
    name: unknown
  ) {
    const expectedChallenge = readChallenge(challengeToken, "passkey_register", user.id);

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origins(),
        expectedRPID: rpId(),
        requireUserVerification: true,
      });
    } catch {
      throw new PasskeyError("Could not verify this passkey. Try again.");
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new PasskeyError("Could not verify this passkey. Try again.");
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    if (await UserPasskey.findOne({ where: { credentialId: credential.id } })) {
      throw new PasskeyError("This passkey is already added.");
    }

    const passkey = await UserPasskey.create({
      userId: user.id,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: response.response?.transports || credential.transports || [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: cleanName(name),
    });
    return publicPasskey(passkey);
  }

  /** Sign-in step 1. No account is named: the browser offers the passkeys it has. */
  static async authenticationOptions() {
    const options = await generateAuthenticationOptions({
      rpID: rpId(),
      userVerification: "required",
    });
    return {
      options,
      challengeToken: signChallenge("passkey_login", options.challenge),
    };
  }

  /** Sign-in step 2: check the signature. Returns the account it belongs to. */
  static async authenticate(challengeToken: unknown, response: AuthenticationResponseJSON) {
    const expectedChallenge = readChallenge(challengeToken, "passkey_login");

    const passkey = response?.id
      ? await UserPasskey.findOne({ where: { credentialId: response.id } })
      : null;
    if (!passkey) {
      throw new PasskeyError(
        "This passkey isn't set up for 2keevo anymore. Sign in with your password, then add it again."
      );
    }

    const handle = response.response?.userHandle;
    if (handle && isoBase64URL.toUTF8String(handle) !== String(passkey.userId)) {
      throw new PasskeyError("Could not verify this passkey. Try again.");
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origins(),
        expectedRPID: rpId(),
        credential: {
          id: passkey.credentialId,
          publicKey: isoBase64URL.toBuffer(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
        requireUserVerification: true,
      });
    } catch {
      throw new PasskeyError("Could not verify this passkey. Try again.");
    }
    if (!verification.verified) {
      throw new PasskeyError("Could not verify this passkey. Try again.");
    }

    await passkey.update({
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    });

    const user = await User.findByPk(passkey.userId);
    if (!user) throw new PasskeyError("Could not verify this passkey. Try again.");
    return { user, passkey };
  }

  /**
   * Let this passkey open the vault: the browser proved it holds the passkey
   * (a fresh signature) and sends the user key wrapped with its PRF secret.
   */
  static async saveUnlockKey(userId: number, challengeToken: unknown, response: AuthenticationResponseJSON, prfUserKey: unknown) {
    const text = String(prfUserKey || "");
    if (!WRAPPED_KEY.test(text)) throw new PasskeyError("That unlock key isn't valid.");
    const { user, passkey } = await this.authenticate(challengeToken, response);
    if (user.id !== userId || !user.e2eEnabled) throw new PasskeyError("That passkey belongs to another account.");
    await passkey.update({ prfUserKey: text });
    return publicPasskey(passkey);
  }

  /** The user key changed (end-to-end turned on again, or off): old unlock copies are useless. */
  static async forgetUnlockKeys(userId: number, transaction?: any) {
    await UserPasskey.update({ prfUserKey: null }, { where: { userId }, transaction });
  }

  static async rename(userId: number, id: number, name: unknown) {
    const passkey = await UserPasskey.findOne({ where: { id, userId } });
    if (!passkey) throw new PasskeyError("That passkey was not found.");
    await passkey.update({ name: cleanName(name) });
    return publicPasskey(passkey);
  }

  static async remove(userId: number, id: number) {
    const passkey = await UserPasskey.findOne({ where: { id, userId } });
    if (!passkey) throw new PasskeyError("That passkey was not found.");
    await passkey.destroy();
    return publicPasskey(passkey);
  }
}

export default PasskeyService;
