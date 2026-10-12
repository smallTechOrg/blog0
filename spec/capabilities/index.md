# Capabilities index

| Capability | File | Phase | Summary |
|---|---|---|---|
| Admin auth | `admin-auth.md` | 1 (Team page: 4, on hold) | Per-user email+password sessions, seeded first admin, CLI to add admins |
| Article authoring | `article-authoring.md` | 1 | Markdown editor with live Read preview, revisions on save, publish/unpublish/delete draft |
| Jev TLDR deck | `jev-tldr.md` | 1 | One explicit AI call picks verbatim lines + reasons; writer hand-edits; generation ledger |
| Article reading | `article-reading.md` | 1 | Public Read view + TLDR deck exactly like the design, `/p/<slug>/tldr` deep link, capsule |
| Format lifecycle | `format-lifecycle.md` | 1, 3 (statuses) → 4 (Regenerate, on hold) | Extensible formats with computed status; TLDR stale + explicit Regenerate; Listen text-changed warning |
| AI cost ledger | `ai-cost-ledger.md` | 1 (recording) → 4 (dashboard, on hold) | Per-generation cost and month-to-date total |
| Reader site | `reader-site.md` | 2 | Home (About, Featured, Latest), Archive + topics, About page, boot strip, theme, OG, seed posts + seeded decks (`seed:tldr`) |
| Newsletter signup | `newsletter-signup.md` | 2 | Footer signup stored server-side, admin list + CSV |
| Share (paragraph, article, deck) | `paragraph-share.md` | 2 | Highlight a paragraph → copy quote + deep link; share to LinkedIn, X, WhatsApp, Notes, Notion, Copy link; native sheet on touch |
| Designer mode | `designer-mode.md` | 2 | Zero-install run (Node + pnpm only) on embedded PGlite with the same migrations + seeds; `pnpm dev:design` |
| Listen audio | `listen-audio.md` | 3 | Upload mp3/m4a (content-probed, limits) ⇒ `ready`, non-blocking text-changed warning, local-disk storage, `/media/` range streaming, real player on article / card overlay / capsule minutes |
| Listen sync | `listen-sync.md` | 3 | Paragraph timing estimated at read time (stored aligner marks win when they cover the text), soft highlight, auto-follow with **Follow audio**, click-to-seek; aligner-facing sync API |
| Media images | `media-images.md` | 3 | Inline image upload from the editor toolbar / drag-drop, alt prompt, Markdown inserted at the cursor |
| Revision history | `revision-history.md` | **deferred** | Browse, view, restore versions (not scheduled) |
| Publication record | `publication-record.md` | 4 (**on hold**) | Published/Updated dates, corrections note, optional sign-off |
| Container image | `container-image.md` | 5 | One non-root OCI image: web server + release step (migrate/verify/seed), live/ready probes, storage volume, graceful shutdown, deploy runbook |
| Backup and restore | `backup-restore.md` | 5 | Snapshot-consistent Postgres dump + storage archive + manifest; restore into a named DB/dir with a row/file-count check |
| Abuse protection | `abuse-protection.md` | 5 | Login/newsletter caps counted atomically in Postgres (survive restarts, shared across instances); nonce CSP + security headers |
| Alignment worker, alignment jobs, sentence-level Listen | written at start of Phase 6 | 6 | Local faster-whisper auto-sync (see `spec/roadmap.md`) |

Phases 1–3 and Phase 5 are done (Phase 5: commits 51aad2f, e72ed9d, 7923781 + a follow-up drift-fix
commit); Phase 4 is on hold (user decision, 2026-10-13) and revision history is
deferred outright (`spec/roadmap.md` → Phase 4).
