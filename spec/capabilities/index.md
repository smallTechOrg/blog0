# Capabilities index

| Capability | File | Phase | Summary |
|---|---|---|---|
| Admin auth | `admin-auth.md` | 1 (Team page: 4) | Per-user email+password sessions, seeded first admin, CLI to add admins |
| Article authoring | `article-authoring.md` | 1 | Markdown editor with live Read preview, revisions on save, publish/unpublish/delete draft |
| Jev TLDR deck | `jev-tldr.md` | 1 | One explicit AI call picks verbatim lines + reasons; writer hand-edits; generation ledger |
| Article reading | `article-reading.md` | 1 | Public Read view + TLDR deck exactly like the design, `/p/<slug>/tldr` deep link, capsule |
| Format lifecycle | `format-lifecycle.md` | 1 (computed status) → 4 (full) | Extensible formats with computed status; stale + explicit Regenerate/Re-sync |
| AI cost ledger | `ai-cost-ledger.md` | 1 (recording) → 4 (dashboard) | Per-generation cost and month-to-date total |
| Reader site | `reader-site.md` | 2 | Home (About, Featured, Latest), Archive + topics, About page, theme, OG, seed posts |
| Newsletter signup | `newsletter-signup.md` | 2 | Footer signup stored server-side, admin list + CSV |
| Paragraph share | `paragraph-share.md` | 2 | Highlight a paragraph → copy quote + deep link, share to LinkedIn / X |
| Listen audio | `listen-audio.md` | 3 | Upload mp3/m4a, local storage interface, range streaming, player |
| Listen sync | `listen-sync.md` | 3 | Tap-along paragraph cues, reader highlight + auto-scroll, stale handling |
| Media images | `media-images.md` | 3 | Inline image upload from the editor |
| Revision history | `revision-history.md` | 4 | Browse, view, restore versions |
| Publication record | `publication-record.md` | 4 | Published/Updated dates, corrections note, optional sign-off |
| Container image, backup/restore, abuse protection | written at start of Phase 5 | 5 | Deploy hardening (see `spec/roadmap.md`) |
| Alignment worker, alignment jobs, sentence-level Listen | written at start of Phase 6 | 6 | Local faster-whisper auto-sync (see `spec/roadmap.md`) |

v0.1 first win (Phase 1) = **admin-auth, article-authoring, jev-tldr, article-reading** (with the
Phase-1 slices of format-lifecycle and ai-cost-ledger built inside them).
