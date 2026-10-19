# Roadmap

Planned features for the notes/vault app (backend: `notes_back`, frontend: `notes_front`).
We implement them step by step, in the order of the **Next up** list. Tick an item when it is merged.

Effort: **S** = a day or less, **M** = a few days, **L** = a week or more.

## Next up

1. [ ] Per-device sessions (fixes random logouts)
2. [ ] Two-factor authentication (TOTP + recovery codes)
3. [ ] Fix note encryption key / IV
4. [ ] Audit log
5. [ ] TOTP codes inside login items
6. [ ] One-time secret links

---

## Step 1: Per-device sessions — M

**Problem:** `users.refreshTokenId` holds one value, so logging in on a second device (or two tabs
refreshing at the same moment) invalidates the other session → user gets logged out.

- [ ] Migration: `user_sessions` table (`id`, `userId`, `refreshTokenHash`, `previousTokenHash`,
      `rotatedAt`, `userAgent`, `ip`, `lastUsedAt`, `expiresAt`, `revokedAt`, `kind` = web | extension).
- [ ] `AuthService.issueSession` / `rotateSession` / `revokeSession` work with the table instead of
      `users.refreshTokenId` / `extensionRefreshTokenId`.
- [ ] Short grace window (~30 s) where the previous refresh token is still accepted (multiple tabs).
- [ ] Password reset / 2FA changes revoke all sessions.
- [ ] Endpoints: `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-all`.
- [ ] Frontend: "Active devices" list on the Security page.

## Step 2: Two-factor authentication (TOTP) — M

The 2FA code is asked **only when a new session starts** (password login on a device). Background
token refresh never asks for it.

Backend:
- [ ] Migration `users`: `twoFactorEnabled` (bool), `twoFactorSecret` (encrypted with
      `util/encryption.ts`), `twoFactorRecoveryCodes` (JSONB, sha256 hashes), `twoFactorLastStep` (replay guard).
- [ ] Dependencies: `otplib`, `qrcode` (QR generated server-side as a data URL).
- [ ] `TwoFactorService`: `setup`, `enable`, `verify` (TOTP ±1 step or recovery code), `disable`
      (password + code), `regenerateRecoveryCodes`.
- [ ] `/auth/login` and `/auth/extension/login`: if 2FA is on, return
      `{ twoFactorRequired, challengeToken }` (JWT `type: "2fa"`, 5 min) instead of a session.
- [ ] `POST /auth/2fa/verify` and `POST /auth/extension/2fa/verify`, strict rate limit (5 / 15 min).
- [ ] `isAuth`: accept only `type === "access"` (today it only rejects `refresh`).
- [ ] Management routes (behind `isAuth`): `GET /auth/2fa/status`, `POST /auth/2fa/setup`,
      `/enable`, `/disable`, `/recovery-codes`.
- [ ] Email notification when 2FA is turned on / off. Password reset does **not** disable 2FA.

Frontend:
- [ ] Login: second step with antd `Input.OTP` (`autoComplete="one-time-code"`), "Use a recovery
      code" link, "Back" link. `challengeToken` kept in component state only.
- [ ] `/settings/security` page: enable wizard (QR / manual secret → confirm code → save recovery
      codes), status, regenerate codes, disable.
- [ ] Extension direct login handles the 2FA step.

Later options:
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
- [ ] Vault health report: weak / reused / old passwords, breach check via HIBP k-anonymity — M
- [ ] Auto-clear clipboard after 30 s (`useFieldClipboard`) — S
- [ ] Auto-lock after idle time — S
- [ ] New-device login alerts by email — S
- [ ] Company policies: require 2FA, min password strength, block export, session lifetime — M

### Items
- [ ] Version history with restore — M
- [ ] Encrypted file attachments (SSH keys, `.env`, certificates) — M
- [ ] Password age / rotation reminders via notifications — S
- [ ] Custom item templates per company — M
- [ ] Tags + search filters (`tag:prod category:ssh`) — S–M
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
- [ ] Importers: Bitwarden JSON, 1Password `.1pux`, LastPass CSV, Chrome/Firefox CSV, KeePass XML — M
- [ ] Password-protected backup export — S
- [ ] Extension: save on submit, update changed password, generate in signup forms, autofill cards/addresses — M
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
