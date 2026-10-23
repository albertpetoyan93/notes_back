/**
 * Passkeys for other websites, stored on login items in `content.passkeys`.
 *
 * - The private key leaves the server only through the extension's passkey endpoint.
 *   Everything else (the vault, shares, the activity log) sees the passkey without it.
 * - The server owns stored passkeys: an edit from the vault can remove a passkey,
 *   but never adds, changes or drops one by accident.
 */

export interface StoredPasskey {
  /** base64url, as the site knows it. */
  credentialId: string;
  /** The site's domain, e.g. "github.com". */
  rpId: string;
  /** base64url user handle the site gave when the passkey was made. */
  userHandle: string;
  userName: string;
  userDisplayName?: string;
  /** PKCS#8 private key, base64url. ES256 (P-256) only. */
  privateKey: string;
  /** COSE algorithm: -7 = ES256. */
  algorithm: number;
  createdAt: string;
}

export type PublicPasskey = Omit<StoredPasskey, "privateKey">;

const MAX_PASSKEYS_PER_ITEM = 10;
const B64URL = /^[A-Za-z0-9_-]+$/;

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

/** A valid stored passkey, or null. Used for anything coming from a client. */
export function cleanPasskey(value: any): StoredPasskey | null {
  if (!value || typeof value !== "object") return null;
  const credentialId = text(value.credentialId, 1024);
  const rpId = text(value.rpId, 253).toLowerCase();
  const privateKey = text(value.privateKey, 4096);
  const userHandle = text(value.userHandle, 512);
  if (!B64URL.test(credentialId) || !B64URL.test(privateKey)) return null;
  if (userHandle && !B64URL.test(userHandle)) return null;
  if (!/^[a-z0-9.-]+$/.test(rpId)) return null;
  if (Number(value.algorithm ?? -7) !== -7) return null;
  return {
    credentialId,
    rpId,
    userHandle,
    userName: text(value.userName, 255),
    userDisplayName: text(value.userDisplayName, 255) || undefined,
    privateKey,
    algorithm: -7,
    createdAt: text(value.createdAt, 40) || new Date().toISOString(),
  };
}

export function storedPasskeys(content: any): StoredPasskey[] {
  const list = content && typeof content === "object" ? content.passkeys : null;
  return Array.isArray(list) ? list.filter((item) => item && item.credentialId) : [];
}

/** The content as clients other than the extension get it: passkeys without keys. */
export function withoutPrivateKeys(content: any) {
  const list = storedPasskeys(content);
  if (!list.length) return content;
  return {
    ...content,
    passkeys: list.map(({ privateKey: _privateKey, ...rest }) => rest),
  };
}

/**
 * Content to save when an item is edited. `incoming.passkeys` says which passkeys
 * to keep (by credential id); left out, all of them stay. Keys always come from storage.
 */
export function mergeOnUpdate(existing: any, incoming: any) {
  if (!incoming || typeof incoming !== "object") return incoming;
  const stored = storedPasskeys(existing);
  const next = { ...incoming };
  if (!stored.length) {
    delete next.passkeys;
    return next;
  }
  if (!Array.isArray(incoming.passkeys)) {
    next.passkeys = stored;
    return next;
  }
  const keep = new Set(
    incoming.passkeys.map((item: any) => String(item?.credentialId || "")).filter(Boolean)
  );
  const kept = stored.filter((passkey) => keep.has(passkey.credentialId));
  if (kept.length) next.passkeys = kept;
  else delete next.passkeys;
  return next;
}

/** Content for a new item (create or import): only well-formed passkeys survive. */
export function cleanOnCreate(content: any) {
  if (!content || typeof content !== "object" || !("passkeys" in content)) return content;
  const list = Array.isArray(content.passkeys)
    ? content.passkeys.map(cleanPasskey).filter(Boolean).slice(0, MAX_PASSKEYS_PER_ITEM)
    : [];
  const next = { ...content };
  if (list.length) next.passkeys = list;
  else delete next.passkeys;
  return next;
}

/** Add a passkey to an item's content, replacing one for the same site and account. */
export function addPasskey(content: any, passkey: StoredPasskey) {
  const base = content && typeof content === "object" ? content : { mainContent: "", customFields: [] };
  const others = storedPasskeys(base).filter(
    (item) => !(item.rpId === passkey.rpId && item.userHandle === passkey.userHandle)
  );
  if (others.length >= MAX_PASSKEYS_PER_ITEM) {
    throw Object.assign(new Error("This item already has the most passkeys it can hold."), { status: 400 });
  }
  return { ...base, passkeys: [...others, passkey] };
}

/**
 * WebAuthn's rule: a passkey for `github.com` works on github.com and its subdomains
 * (www.github.com, gist.github.com), never on a parent or a sibling domain.
 */
export function rpIdMatchesHost(rpId: string, host: string) {
  const site = rpId.toLowerCase().replace(/\.$/, "");
  const page = host.toLowerCase().replace(/\.$/, "");
  return page === site || page.endsWith(`.${site}`);
}
