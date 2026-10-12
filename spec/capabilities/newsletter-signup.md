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
- At most 10 submissions per IP per hour; beyond that the form shows the try-again message.
- No confirmation email is sent in v0.1.

## Success Criteria
- [ ] POST `/api/newsletter` `{ email: " A@B.com " }` stores `a@b.com`; repeating returns the same success and still one row.
- [ ] Invalid email → 400 `VALIDATION_FAILED`; the form shows the design's message without a request.
- [ ] The 11th request from one IP within an hour → 429.
- [ ] In Chromium, submitting the footer form shows "You’re in. First issue lands Thursday." and the address appears in Admin → Subscribers; Export CSV downloads a file with a header row and that address.
