# Roadmap

Planned features for the vault app. Repos: `notes_back` (API), `notes_front` (vault app),
`notes_web` (public site), `notes_extension` (browser extension).

We build them one step at a time, in the order of the **Next up** list.

Status marks:
- **[x]** done (built and tested)
- **[~]** partly done: the note after the item says what is missing
- **[ ]** not started
- **🔀 Not merged:** the work is on branch `claude/2fa-login-implementation-f1tp22` in all four
  repos and is not merged into `main` or deployed yet.

Effort: **S** = a day or less, **M** = a few days, **L** = a week or more.

## Next up

1. [x] Per-device sessions (fixes random logouts) 🔀 Not merged
2. [x] Two-factor authentication (TOTP + recovery codes) 🔀 Not merged
3. [ ] Fix note encryption key / IV
4. [ ] Audit log
5. [ ] TOTP codes inside login items
6. [ ] One-time secret links

### Before steps 1 and 2 go live

- [ ] Merge the branch in all four repos.
- [ ] Run `npm run migrate:prod` (migrations `021_create_user_sessions`, `022_add_two_factor`).
      Done on the local dev database.
- [ ] Set `ENCRYPTION_KEY` in production. 2FA secrets are encrypted with it, and without it the
      code falls back to a key written in the source.
- [ ] Publish extension version 1.2.0 to the Chrome store.

---

## Step 1: Per-device sessions (M) [x] 🔀 Not merged

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

## Step 2: Two-factor authentication (TOTP) (M) [x] 🔀 Not merged

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

## Step 3: Fix note encryption — S–M

`src/util/crypto.ts` uses a hard-coded key and a fixed IV (AES-128-CBC). Anyone with the repo and a
DB dump can decrypt every note.

- [ ] Encrypt notes with AES-256-GCM, key from env (`ENCRYPTION_KEY`, required in production — no
      fallback), random IV per value.
- [ ] Version prefix on ciphertext (e.g. `v2:`) so old and new formats can coexist.
- [ ] Migration script that re-encrypts existing notes.

## Step 4: Audit log — M

- [ ] `audit_events` table: who, what (view / reveal / copy / edit / share / delete / login / 2FA
      change), which item, company, IP, user agent, time.
- [ ] Per-item history and per-company log (admins), with filters.
- [ ] Offboarding helper: when a member is removed, list everything they could access so it can be rotated.

## Step 5: TOTP codes inside login items — M

- [ ] `totp` field type on login items (accept secret or `otpauth://` URI, or scan QR from image).
- [ ] Live 6-digit code with countdown in item detail; copy button.
- [ ] Extension autofills the code.

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
