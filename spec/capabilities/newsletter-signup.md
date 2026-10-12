# Capability: Newsletter signup

Phase 2. Sending newsletters is out of scope (later).

## What It Does
Stores a reader's email (and optional name) from the footer form so smallTech can mail them later,
and lets admins see and export the list.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Email | address ≤ 254 | footer form | yes |
| Name | text ≤ 120 | footer form | no |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Subscriber | email, name, time, source, status | database |
| Confirmation | "You’re in. First issue lands Thursday." | footer |
| Subscriber list / CSV | table + download | Admin → Subscribers |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | upsert subscriber | form shows "That didn’t go through. Try again?" |

## Business Rules
- Client and server both validate the email; the design's message "Enter a valid email, like
  you@company.com." is shown for invalid input.
- Emails are trimmed and lower-cased; re-subscribing an existing address succeeds silently
  (no hint whether it existed) and updates the name if given.
- Submission caps (any cap hit → the form shows the try-again message): at most 3 per email
  address per hour and 300 across the whole site per hour, always; plus 10 per client IP per hour
  when the client IP is known (only behind a configured trusted proxy — when the IP is unknown the
  per-IP cap is skipped). Invalid submissions are rejected before they count. A production
  deployment behind a proxy must configure the trusted proxy hop count (`spec/architecture.md` §6).
- No confirmation email is sent in v0.1.

## Success Criteria
- [ ] POST `/api/newsletter` `{ email: " A@B.com " }` stores `a@b.com`; repeating returns the same success and still one row.
- [ ] Invalid email → 400 `VALIDATION_FAILED`; the form shows the design's message without a request.
- [ ] The 4th valid request for one email within an hour → 429 with `Retry-After`; an invalid-email request does not count toward any cap.
- [ ] With `BLOG0_TRUSTED_PROXY_HOPS=1`, the 11th valid request (distinct emails) from one `X-Forwarded-For` IP within an hour → 429; with hops = 0 the same 11 requests all succeed (per-IP cap skipped).
- [ ] The 301st valid request site-wide within an hour → 429.
- [ ] In Chromium, submitting the footer form shows "You’re in. First issue lands Thursday." and the address appears in Admin → Subscribers; Export CSV downloads a file with a header row and that address.
