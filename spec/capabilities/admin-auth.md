# Capability: Admin auth

Phase 1 (sign-in, sign-out, seeded first admin, CLI to add admins). The Team page and password
change (see end; was Phase 4) are **Frozen — not scheduled**. Throttle mechanics: `spec/architecture.md` §6.

## What It Does
Lets a handful of named smallTech writers sign in with email + password so every save, revision,
generation and publish is attributed to a distinct person.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Email | string (≤ 254, valid address, case-insensitive) | sign-in form | yes |
| Password | string (12–200 chars) | sign-in form | yes |
| First admin email / password / display name | env `BLOG0_ADMIN_EMAIL`, `BLOG0_ADMIN_PASSWORD`, `BLOG0_ADMIN_NAME` | `.env` via `pnpm db:seed` | yes |
| Extra admin | `--email`, `--name`, password from `BLOG0_NEW_ADMIN_PASSWORD` env or interactive prompt | `pnpm admin:create` | yes |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Session | opaque token cookie `blog0_session` (30-day sliding) | browser |
| Session record | hashed token, user, expiry | database |
| Current user | id, email, display name | admin UI, attribution on every write |
| Sign-in log line | outcome + masked email | structured log |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | read user, write session | 500 INTERNAL with retry message; nothing half-written |

## Business Rules
- All users are admins (no roles). A disabled user cannot sign in.
- Wrong email and wrong password produce the same message: "Email or password is incorrect."
- **Stage A (replaces the hard lock):** nobody can lock an account by knowing its email. After 5
  failed attempts for an email, each further attempt must wait 1 s, then 2, 4, 8 … up to 60 s after
  the previous one; an attempt inside the wait is refused with "Too many attempts — try again in N
  seconds." and a correct password after the wait signs in. Hard caps remain only per (email, real
  IP) — 5 per 15 min — and per real IP — 50 per 15 min (HOW: `spec/architecture.md` §6).
- **Stage A — password reset CLI:** `pnpm admin:reset-password --email <e>` (and `node
  reset-password.mjs --email <e>` in the production image) sets a new password (from
  `BLOG0_NEW_ADMIN_PASSWORD` or a hidden prompt, 12–200 chars), ends **all** of that user's
  sessions, clears the email's login delay, and prints only the masked email and the number of
  sessions ended (HOW: `spec/architecture.md` §12.1; runbook `docs/deploy.md`).
- Passwords are never stored or logged in clear; the seeded admin's password is only set when the
  admin is first created (unless an explicit reset flag is passed).
- Seeding refuses (exit 1, clear message) when the admin password is shorter than 12 characters
  or the email is missing.
- Every admin page and admin API requires a valid session; pages redirect to sign-in with a
  `next` return path; APIs answer 401.
- Mutating requests must come from the site's own origin.
- Signing out ends only the current session.

## Success Criteria
- [ ] `pnpm db:seed` on an empty DB creates the site and the admin; running it again changes nothing and prints "ok" for both.
- [ ] POST `/api/auth/login` with the seeded credentials returns the user and sets an httpOnly, SameSite=Lax cookie; the DB holds only a hash of the token (raw token not found in `session.token_hash`).
- [ ] Wrong password and unknown email both return 401 `BAD_CREDENTIALS` with the identical message.
- [ ] ~~The 6th failure within 15 minutes returns 429 even for the right password~~ — superseded by Stage A: (injected `now`, `direct` IP, memory **and** DB store) 5 wrong passwords at t=0 → an attempt at t+0.5 s is 429 with `Retry-After: 1` and is not counted; the correct password at t+1 s → 200; then 7 wrong passwords spaced by their waits produce waits 1, 2, 4, 8, 16, 32, 60 s and the 8th wait is still 60; 20 wrong passwords never stop the correct password from succeeding once its wait has passed. With a real IP (`BLOG0_TRUSTED_PROXY_HOPS=1`): the 6th failure of one (email, IP) within 15 min → 429 while the same email from another IP is only delayed; the 51st failure from one IP across emails → 429. A new `DbRateLimitStore` instance (simulated restart) keeps the delay.
- [ ] Stage A: `BLOG0_NEW_ADMIN_PASSWORD=<new> pnpm admin:reset-password --email <seeded>` prints `password reset for s***@… · 2 sessions ended` after two logins; both old cookies → 401; the old password → 401, the new one → 200; an unknown email exits 1 and changes nothing; an 11-char password exits 2; the output and the `auth.password_reset` line never contain the password. The container E2E runs `node reset-password.mjs` inside the image with the same result.
- [ ] GET `/api/admin/articles` without a cookie → 401; GET `/admin` without a cookie → redirect to `/admin/login?next=%2Fadmin`.
- [ ] POST to an admin API with `Origin: https://evil.example` → 403 `FORBIDDEN_ORIGIN`.
- [ ] After logout the old cookie value is rejected (401) on a second request.
- [ ] `pnpm admin:create --email b@smalltech.in --name "B Writer"` creates a second user who can sign in; revisions they save carry their name.
- [ ] Session use more than 24 h after `last_seen_at` extends `expires_at` (tested with injected clock).
- [ ] An `auth.login` log line is emitted per attempt with `outcome` and a masked email, never the password.

## Team additions (was Phase 4; Frozen — not scheduled)
- Team page lists users; any admin can add an admin (email, name, initial password ≥ 12).
- A user can change their own password (current password required); their other sessions end.
