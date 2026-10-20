# Roadmap

Planned features for the vault app. Repos: `notes_back` (API), `notes_front` (vault app),
`notes_web` (public site), `notes_extension` (browser extension).

We build them one step at a time, in the order of the **Next up** list.

Status marks:
- **[x]** done (built and tested)
- **[~]** partly done: the note after the item says what is missing
- **[ ]** not started
- **🔀 Not merged:** built and tested, but not committed or merged into `main` yet.

Effort: **S** = a day or less, **M** = a few days, **L** = a week or more.

## Next up

1. [x] Per-device sessions (fixes random logouts)
2. [x] Two-factor authentication (TOTP + recovery codes)
3. [x] Encrypt every item, key checks and key rotation
4. [x] Audit log, and removing shares from either side
5. [x] TOTP codes inside login items 🔀 Not merged
6. [ ] One-time secret links

### Before steps 1–4 go live

- [x] Merge the branch in all four repos (merged into `main` on 20 Oct 2026).
- [ ] Back up the production database, then run `npm run migrate:prod` (migrations
      `021_create_user_sessions`, `022_add_two_factor`, `023_encrypt_all_notes`,
      `024_create_audit_events`). 021–023 are done on the local dev database; 024 was tested on a
      copy of it.
- [ ] **Before deploying step 3**, copy the encryption block (`ENCRYPTION_KEY`,
      `ENCRYPTION_KEY_ID=2`, `ENCRYPTION_OLD_KEYS=1:…`) from the local `env/production.env` into
      the server's `env/production.env`. The old key was the built-in one from the source code;
      production now refuses to start with it as the current key. Keep a copy of the new key in a
      password manager: without it the data cannot be decrypted.
- [ ] After `migrate:prod` reports no failures, remove `ENCRYPTION_OLD_KEYS` on the server and
      restart.
- [ ] Publish the extension to the Chrome store. Version 1.3.0 includes the 1.2.0 sign-in
      code step and the step 5 code filling.

---

## Step 1: Per-device sessions (M) [x]

**Problem:** `users.refreshTokenId` held one value. Signing in on a second device, or two tabs
refreshing at the same moment, signed the other session out.

- [x] Migration `021`: `user_sessions` table (`userId`, `kind` = web | extension, `tokenHash`,
      `previousTokenHash`, `rotatedAt`, `userAgent`, `ip`, `lastUsedAt`, `expiresAt`). Only hashes
      are stored. Signing out deletes the row.
- [x] `SessionService` creates, rotates and revokes sessions. `AuthService` uses it in place of
      `users.refreshTokenId` / `extensionRefreshTokenId`.
- [x] For 30 seconds after a refresh, the previous web refresh token still works, so several tabs
      can refresh at once. Extension refresh tokens stay single-use.
- [x] Access tokens carry the session id. `isAuth` rejects them as soon as their session is signed
      out.
- [x] Tokens issued before this change are moved into a session on their next refresh, so nobody is
      signed out by the deploy.
- [x] A password reset signs out every device. Turning on 2FA signs out every other device.
- [x] Endpoints: `GET /auth/sessions`, `DELETE /auth/sessions/:id`,
      `POST /auth/sessions/revoke-others`.
- [x] Vault app: "Where you're signed in" list on the Security page, with "Sign out" for one
      device or all other devices.

## Step 2: Two-factor authentication (TOTP) (M) [x]

The code is asked **only when a new session starts** (a password sign-in on a device). A
background token refresh never asks for it.

Backend:
- [x] Migration `022` on `users`: `twoFactorEnabled`, `twoFactorSecret` (encrypted with
      `util/encryption.ts`), `twoFactorRecoveryCodes` (sha256 hashes), `twoFactorLastStep`
      (blocks reuse of a code).
- [x] TOTP written in `util/totp.ts` (no new dependency) and checked against the RFC 6238 test
      vectors.
- [x] `TwoFactorService`: `setup`, `enable`, `verify` (code from the app, ±1 time step, or a
      recovery code; each works once), `disable` (password + code), `regenerateRecoveryCodes`.
- [x] `/auth/login` and `/auth/extension/login` return `{ twoFactorRequired, challengeToken }`
      (5 minutes) instead of a session.
- [x] `POST /auth/2fa/verify` and `POST /auth/extension/2fa/verify`. The 2FA endpoints allow
      10 attempts per 15 minutes.
- [x] `isAuth` accepts only access tokens. Before, it accepted any token type except refresh.
- [x] Management routes (behind `isAuth`): `GET /auth/2fa/status`, `POST /auth/2fa/setup`,
      `/enable`, `/disable`, `/recovery-codes`.
- [x] Email when 2FA is turned on or off. A password reset does **not** turn 2FA off.

Vault app (`notes_front`):
- [x] Sign-in: code step (6 boxes, sends itself when full), "Use a recovery code", "Back to
      sign in".
- [x] `/settings/security` (account menu → Security): turn 2FA on (QR code made in the browser, or
      typing the key in by hand; confirm a code; save 10 recovery codes), new recovery codes, turn
      off.

Public site (`notes_web`):
- [x] The sign-in card has the same code step. Typechecked only, not yet tried in a browser.

Extension (`notes_extension`):
- [x] The popup's sign-in has a code step. Version 1.2.0.

Later options (not started):
- [ ] "Trust this device for 30 days".
- [ ] Re-ask the code for sensitive actions (disable 2FA, change email/password, export).
- [ ] Company policy: require 2FA for members.
- [ ] WebAuthn / passkeys as a second factor.

## Step 3: Encrypt every item (S–M) [x]

What was wrong: notes were encrypted correctly (AES-256-GCM, random IV), but only password, login,
address and card items. SSH keys, DB logins, commands and notes were stored as plain text, and
some older password items too. (`util/crypto.ts`, with its hard-coded key, was not used anywhere.)

- [x] Every item is encrypted when saved, whatever its category. The vault app's "Encrypt content"
      switch is gone.
- [x] Migration `023`: encrypts everything stored as plain text and rewrites older values in the new
      format. Tested on a copy of the dev database: 36 items, all decrypt to exactly what they were.
- [x] Stored values carry a key id (`v2:<keyId>:…`). Values without one still decrypt.
- [x] The server refuses to start in production without `ENCRYPTION_KEY` (no fallback key).
- [x] Changing the key: set a new `ENCRYPTION_KEY` and `ENCRYPTION_KEY_ID`, put the old key in
      `ENCRYPTION_OLD_KEYS`, run `npm run reencrypt:prod`, then remove the old key. 2FA secrets are
      included. Steps are in `src/scripts/reencrypt.ts`.
- [x] An item that cannot be decrypted can no longer be wiped: editing its content is refused
      (409), and saving other fields keeps the stored data.
- [x] Search looks inside content after decryption. Password, PIN and CVV values are not searched.
- [x] Removed unused `util/crypto.ts`.

Later (not started):
- [ ] Rotate the production key (the plan's "Rotate secrets" task) using the steps above.
- [ ] Each key from a secret manager instead of the env file.

## Step 4: Audit log and removing shares (M) [x]

Audit log (`audit_events`, migration `024`). Never stores secret values, only field names.
- [x] Recorded: sign-ins and wrong passwords or 2FA codes; 2FA and recovery-code changes; devices
      signed out; password resets; items created, edited, trashed, restored, moved; Trash emptied;
      a secret field revealed or copied (reported by the vault app); a login sent to the browser
      extension; export and import; item and collection shares, revokes and removals; company
      invites, removals and role changes.
- [x] Repeats of the same reveal/copy within a minute count once.
- [x] Item history (Activity button on an item): the owner, and company owners/admins for company
      items.
- [x] Company log (company → Members → Activity log), filter by person: owners and admins.
- [x] Your own sign-ins and security changes: "Recent account activity" on the Security page.
- [x] Offboarding: removing a member shows which company collections they could open and which
      secrets they revealed or copied, so those can be changed.

Removing shares:
- [x] Owner: "Shared with N people" chip on the item opens the share dialog, where each person can
      be revoked (this existed; the chip makes it visible).
- [x] Recipient: "Remove from my list" on an item shared with you. If it reaches you through a
      shared collection, you are offered to leave that collection. The owner gets a notification.
- [x] API: `POST /notes/:id/leave`, `POST /collections/:id/leave`.

Later (not started):
- [ ] A sidebar link to the company log (today: Members → Activity log).
- [ ] Keep the log for a set time (for example one year), then delete old events.
- [ ] Export the log as CSV.
- [ ] Record items opened in the browser extension popup.

## Step 5: TOTP codes inside login items — M [x] 🔀 Not merged

- [x] Authenticator key field on login items. It takes the text key, an `otpauth://totp/` link, or
      a QR code image (upload, or paste a screenshot into the field). A field counts as a key when
      its name is "Authenticator key", "2FA", "TOTP", "OTP", "MFA" or "Two-factor" (optionally
      followed by key/secret/code) **and** its value is a valid key, so old "2FA" fields holding
      other notes keep working. New logins start with the field; password-manager imports fill it.
- [x] Live code with a countdown ring and a copy button in the item detail. Copying is logged in
      the activity history. The editor shows the current code under the key, so it can be checked
      against the site.
- [x] Keys are secret: encrypted like passwords, hidden in the UI, left out of search and of site
      matching. Codes are made in the browser and extension and never stored or sent.
- [x] Extension: the fill icon appears on "enter your code" fields (`one-time-code`, OTP/2FA/MFA
      names, or six one-digit boxes) and fills the current code for the site. Only the digits reach
      the page; the key stays in the extension's background script. The popup shows each login's
      code; clicking copies it. Version 1.3.0.
- Tested: codes match the backend's TOTP and the RFC 6238 test values; QR upload, detail view,
  activity log, search and the autofill API on a copy of the dev database; the extension's
  content script on a test page with single, split and named code fields. The extension popup was
  only built, not tried in the browser.

## Step 6: One-time secret links — M

- [ ] Encrypt in the browser; key lives in the URL `#fragment` (server never sees it).
- [ ] Options: expires after N hours / N views, optional passphrase.
- [ ] Public page to open the secret once; link is burned after viewing.

---

## Backlog

### Security
- [~] Vault health report — M. Weak, reused and old passwords are flagged (Security health in the
      sidebar). Missing: breach check with HIBP k-anonymity.
- [ ] Auto-clear clipboard after 30 s (`useFieldClipboard`) — S
- [ ] Auto-lock after idle time — S
- [ ] New-device sign-in alerts by email — S (sessions now store device and IP, which this needs)
- [ ] Company policies: require 2FA, min password strength, block export, session lifetime — M

### Items
- [ ] Version history with restore — M
- [ ] Encrypted file attachments (SSH keys, `.env`, certificates) — M
- [ ] Password age / rotation reminders via notifications — S
- [ ] Custom item templates per company — M
- [~] Tags + search filters — S–M. Tags and filtering by tag, category and project work. Missing:
      typed search syntax like `tag:prod category:ssh`.
- [ ] Generator: passphrases, character sets, strength meter (zxcvbn) — S

### Sharing and teams
- [ ] Finer permissions: view / use-but-not-reveal / edit per collection — M
- [ ] Access requests with admin approval — S–M
- [ ] SSO (Google / Microsoft / OIDC) — L
- [ ] SCIM / directory sync — L

### Developer / DevOps
- [ ] CLI (`keevo get`, `keevo run -- <cmd>` injecting env vars) — M–L
- [ ] Service tokens (read-only, scoped to a collection) for CI/CD — M
- [ ] `.env` import / export — S
- [ ] Copy connection string / `psql` command from `db` items — S
- [ ] SSH agent — L

### Convenience
- [~] Importers — M. In progress in `notes_front` (not committed yet): CSV from Chrome, Firefox,
      Bitwarden and LastPass. Missing: 1Password `.1pux`, KeePass XML. The app's own backup
      import/export already works.
- [ ] Password-protected backup export — S
- [x] Extension: save on submit, update a changed password, generate in signup forms, fill cards and
      addresses — M
- [ ] Passkey storage — L
- [ ] PWA / mobile, offline read-only — M–L
- [ ] Emergency access (trusted contact, auto-grant after N days) — M

### End-to-end encryption (separate big project)
- [ ] Master password (Bitwarden style): client-side Argon2id → `masterKey`; server stores only a
      hash of `masterPasswordHash`; vault key `userKey` stored encrypted with `masterKey`.
- [ ] `POST /auth/prelogin` returns KDF params; login sends hash; 2FA step unchanged.
- [ ] Lock vs logout: session stays, vault key only in memory; unlock with master password locally (no 2FA).
- [ ] Per-user key pairs + company keys for sharing (`note_shares`, collections, companies).
- [ ] Client-side migration of existing notes; search moves to the browser.
- [ ] Recovery: account recovery key / company admin recovery (forgotten master password = data lost otherwise).
- [ ] Optional 1Password-style Secret Key; later passkey unlock (WebAuthn PRF).
