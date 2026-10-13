# Capabilities index

| Capability | File | Phase | Summary |
|---|---|---|---|
| Admin auth | `admin-auth.md` | 1 (Team page: Frozen — not scheduled) | Per-user email+password sessions, seeded first admin, CLI to add admins |
| Article authoring | `article-authoring.md` | 1 | Markdown editor with live Read preview, revisions on save, publish/unpublish/delete draft |
| Jev TLDR deck | `jev-tldr.md` | 1, 8 | One explicit AI call (Phase 8: `typesafe/jev-1.13` decisions) scores every sentence; top k verbatim lines become the deck; writer hand-edits with relevance shown; generation ledger |
| Article reading | `article-reading.md` | 1 | Public Read view + TLDR deck exactly like the design, `/p/<slug>/tldr` deep link, capsule |
| Format lifecycle | `format-lifecycle.md` | 1, 3 (statuses), 8 (Regenerate button) — stale banner: Frozen — not scheduled | Extensible formats with computed status; TLDR stale; Listen text-changed warning |
| AI cost ledger | `ai-cost-ledger.md` | 1 (recording) — dashboard: Frozen — not scheduled | Per-generation cost and month-to-date total |
| Reader site | `reader-site.md` | 2 | Home (About, Featured, Latest), Archive + topics, About page, boot strip, theme, OG, seed posts + seeded decks (`seed:tldr`) |
| Newsletter list | `newsletter-list.md` | 2 (signup) → 7 (owned list) | blog0-owned list with double opt-in, per-subscriber proof of consent, append-only events + suppression, legacy migration, admin audit view + CSV/JSON audit export (supersedes `newsletter-signup.md`) |
| Newsletter issues | `newsletter-issues.md` | 7 | Per-post / digest / manual issues, preview HTML + text, send test, one-click send, send log + stats; sender adapter (Listmonk via REST, recording stub); `pnpm newsletter:sync` |
| Share (paragraph, article, deck) | `paragraph-share.md` | 2 | Highlight a paragraph → copy quote + deep link; share to LinkedIn, X, WhatsApp, Notes, Notion, Copy link; native sheet on touch |
| Designer mode | `designer-mode.md` | 2 | Zero-install run (Node + pnpm only) on embedded PGlite with the same migrations + seeds; `pnpm dev:design` |
| Listen audio | `listen-audio.md` | 3 | Upload mp3/m4a (content-probed, limits) ⇒ `ready`, non-blocking text-changed warning, local-disk storage, `/media/` range streaming, real player on article / card overlay / capsule minutes |
| Listen sync | `listen-sync.md` | 3 | Paragraph timing estimated at read time (stored aligner marks win when they cover the text), soft highlight, auto-follow with **Follow audio**, click-to-seek; aligner-facing sync API |
| Media images | `media-images.md` | 3 | Inline image upload from the editor toolbar / drag-drop, alt prompt, Markdown inserted at the cursor |
| Revision history | `revision-history.md` | **Frozen — not scheduled** | Browse, view, restore versions |
| Publication record | `publication-record.md` | **Frozen — not scheduled** | Published/Updated dates, corrections note, optional sign-off |
| Container image | `container-image.md` | 5 | One non-root OCI image: web server + release step (migrate/verify/seed), live/ready probes, storage volume, graceful shutdown, deploy runbook |
| Backup and restore | `backup-restore.md` | 5 | Snapshot-consistent Postgres dump + storage archive + manifest; restore into a named DB/dir with a row/file-count check |
| Abuse protection | `abuse-protection.md` | 5 | Login/newsletter caps counted atomically in Postgres (survive restarts, shared across instances); nonce CSP + security headers |
| Whisper alignment (exact Listen timing, sentence-level Listen) | none (never written) | **Frozen — not scheduled** (was Phase 6) | Local Whisper auto-sync writing marks through `PUT …/listen` |

**Frozen — development complete (Scaffold, Phases 1–3, 5, 7, 8 done).** No further phases or
feature work (user decision). Every unbuilt item, with a one-line description, is listed in
`spec/roadmap.md` → **Frozen — not scheduled**.
