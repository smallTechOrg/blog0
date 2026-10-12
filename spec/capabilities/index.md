# Capabilities index

| Capability | File | Phase | Summary |
|---|---|---|---|
| Admin auth | `admin-auth.md` | 1 (Team page: 4) | Per-user email+password sessions, seeded first admin, CLI to add admins |
| Article authoring | `article-authoring.md` | 1 | Markdown editor with live Read preview, revisions on save, publish/unpublish/delete draft |
| Jev TLDR deck | `jev-tldr.md` | 1 | One explicit AI call picks verbatim lines + reasons; writer hand-edits; generation ledger |
| Article reading | `article-reading.md` | 1 | Public Read view + TLDR deck exactly like the design, `/p/<slug>/tldr` deep link, capsule |
| Format lifecycle | `format-lifecycle.md` | 1 (computed status) → 4 (full) | Extensible formats with computed status; stale + explicit Regenerate/Re-sync |
| AI cost ledger | `ai-cost-ledger.md` | 1 (recording) → 4 (dashboard) | Per-generation cost and month-to-date total |
| Reader site | `reader-site.md` | 2 | Home (About, Featured, Latest), Archive + topics, About page, boot strip, theme, OG, seed posts + seeded decks (`seed:tldr`) |
| Newsletter signup | `newsletter-signup.md` | 2 | Footer signup stored server-side, admin list + CSV |
| Share (paragraph, article, deck) | `paragraph-share.md` | 2 | Highlight a paragraph → copy quote + deep link; share paragraph/article/deck to LinkedIn, X, WhatsApp, Notes, Notion, Copy link; native sheet on touch |
| Designer mode | `designer-mode.md` | 2 | Zero-install run (Node + pnpm only) on embedded PGlite with the same migrations + seeds; `pnpm dev:design` |
| Listen audio | `listen-audio.md` | 3 (+ fix) | Upload mp3/m4a (content-probed, limits) ⇒ `ready`, non-blocking "may no longer match the text" warning, local-disk storage interface, `/media/` range streaming with ETag, real player on article / card overlay / capsule minutes |
| Listen sync | `listen-sync.md` | 3 (+ fix) | Paragraph timing estimated at read time (word count + pause weight; stored aligner marks win when they cover the text), soft highlight, auto-follow with pause on manual scroll + **Follow audio**, click-to-seek; aligner-facing sync API |
| Media images | `media-images.md` | 3 | Inline image upload from the editor toolbar / drag-drop, alt prompt, Markdown inserted at the cursor |
| Revision history | `revision-history.md` | **deferred** | Browse, view, restore versions (removed from Phase 4 by user decision) |
| Publication record | `publication-record.md` | 4 (**on hold**) | Published/Updated dates, corrections note, optional sign-off |
| Container image, backup/restore, abuse protection | written at start of Phase 5 | 5 | Deploy hardening (see `spec/roadmap.md`) |
| Alignment worker, alignment jobs, sentence-level Listen | written at start of Phase 6 | 6 | Local faster-whisper auto-sync (see `spec/roadmap.md`) |

Phase 4 is **on hold** (user decision, 2026-10-13): its rows above keep their phase number but are
not scheduled; revision history is deferred outright (`spec/roadmap.md` → Phase 4).

v0.1 first win (Phase 1) = **admin-auth, article-authoring, jev-tldr, article-reading** (with the
Phase-1 slices of format-lifecycle and ai-cost-ledger built inside them).
