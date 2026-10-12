# blog0 — UI

Binding visual reference: `spec/design/design-app.js` + `spec/design/design-app.css` (rendered
in `spec/blog0-design-v0.1_files/saved_resource.html`). **Port, don't redesign.** Deviations are
only those in `spec/architecture.md` → `## Design divergences (ask user)`. Quality bar:
`ui-ux.md` of the harness (four states per view, keyboard reachable, reduced motion honoured).

## 1. Porting rules

1. `src/styles/design.css` is a **byte-for-byte copy** of `spec/design/design-app.css`. Never edit
   it; put every new or overriding rule in `src/styles/additions.css` (loaded after it) or
   `src/styles/admin.css`.
2. Components keep the design's **class names, DOM structure, text, constants and timings**
   (e.g. `TDECK_STEP_MS = 720`, `TDECK_WHEEL = 90`, `TDECK_SWIPE = 56`, `TYPE_RUN_MS = 820`,
   `SPLIT_STAGGER = 55`, `BOOT_LINE_MS = 70`, dwell/type formulas). Translate `h(...)` calls into
   TSX one-for-one; replace `var` hooks with typed hooks; keep comments that explain WHY.
3. The design's `#root` becomes `<div id="blog0-root">` (used by `PrintIn`'s selector root).
4. The root layout injects, before paint, the design's theme script extended with persistence:
   read `localStorage['blog0.theme']` (`'light'|'dark'`); else `prefers-color-scheme`; set
   `data-theme` on `<html>` (`suppressHydrationWarning`).
5. Fonts via `next/font/google`: Space Grotesk (400/500/600/700), Source Serif 4 (400/600, italic
   400), JetBrains Mono (400/500), exposed as CSS variables and wired in `additions.css`:
   `:root { --font-head: var(--nf-head), 'Helvetica Neue', Arial, sans-serif; --font-body:
   var(--nf-body), Georgia, 'Times New Roman', serif; --font-mono: var(--nf-mono), ui-monospace,
   Menlo, Consolas, monospace; }`.
6. `prefersReducedMotion()` and all motion hooks live in `src/components/design/motion.ts`;
   everything still renders fully with reduced motion.
7. Brand values (`BRAND`/wordmark, tagline, `BRAND_MAIL`, About texts, publisher) come from the
   `site` record via props, never constants.

## 2. Design → real component map

| Design (design-app.js) | Real file | Phase | Notes |
|---|---|---|---|
| `Icon` | `components/design/Icon.tsx` | 1 | same paths; `name` typed union |
| `useEnter`, `prefersReducedMotion`, `typeClock/typeNow/typeStep` | `components/design/motion.ts` | 1 | module-level clock as design |
| `SplitHeadline`, `Dek`, `dekDelay` | `components/design/SplitHeadline.tsx`, `Dek.tsx` | 1 | |
| `Typewriter` | `components/design/Typewriter.tsx` | 1 | |
| `Wordmark` | `components/design/Wordmark.tsx` | 1 | nought spin; `plain` variant |
| `Masthead` | `components/site/Masthead.tsx` | 1 (2 final) | nav Archive + Subscribe; theme toggle; **no search** (div. 4); compact-on-scroll |
| `Footer`, `NewsletterForm`, `useAsciiHand`, `useEof` | `components/site/Footer.tsx`, `NewsletterForm.tsx`, `AsciiHand.ts` | 1 (form stub) / 2 real | |
| `Boot`, `bootCommand` | `components/site/Boot.tsx` | 2 | behind `SHOW_BOOT_STRIP=false` (div. 6) |
| `usePrintIn` | `components/site/PrintIn.tsx` (client hook component keyed by pathname) | 1 | selector list verbatim, root `#blog0-root` |
| `PostCard` (+ quick TLDR/Listen) | `components/site/PostCard.tsx` | 1 (nav to `/p/<slug>/tldr`) / 2 (overlay) | variants `post`, `card`, `card-lead` |
| `Home` (About, Featured stack, Latest, See More) | `app/(site)/page.tsx` + `components/site/home/*` | 1 (Latest only + stubs) / 2 | `FEATURED_MAX=4`, `FEED_BATCH=5`, stack observer |
| `AboutBody`, `About` | `components/site/about/*`, `app/(site)/about/page.tsx` | 2 | |
| `Archive` (+ topic pills) | `app/(site)/archive/page.tsx`, `components/site/archive/*` | 2 | topic in `?topic=` |
| `HLProvider` (sentence) | `components/reader/ParagraphShare.tsx` + `ShareMenu.tsx` | 2 | paragraph unit (div. 2, 3) |
| `AnnotationLayer` (drag-to-share) | inside `ParagraphShare.tsx` | 2 | selection inside a `.para` opens the same menu |
| `mdToHtml`, `articleBlocks` | server content pipeline → `components/reader/ArticleBody.tsx` | 1 | blocks → `.prose` html + figures |
| `ArticleProse` | `ArticleBody.tsx` (memoised html block) | 1 | |
| `FigSlide47`, `FigAB`, `FIGURES` | `components/figures/FigSlide47.tsx`, `FigAB.tsx`, `registry.ts` | 1 | data constants verbatim |
| `TldrDeck`, `tldrDwell`, `tldrType`, `tldrMinutes`, `tdeckSlide` | `components/reader/TldrDeck.tsx`, `lib/deck/timing.ts` | 1 | slides from the published deck; layout `column` |
| `ShareLinkButton` | `components/reader/ShareLinkButton.tsx` | 1 | |
| `ArticlePage` (modebar strip, readhead, readbody, capsule, artfoot) | `components/reader/ArticleView.tsx`, `ModeBar.tsx`, `ModeCapsule.tsx`, `ReadHead.tsx`, `ArticleFoot.tsx` | 1 | modes read/tldr/listen |
| `AudioPanel` | `components/reader/ListenStub.tsx` (1–2) → `ListenView.tsx` (3) | 1 / 3 | |
| `SummaryOverlay` | `components/site/SummaryHost.tsx` | 2 (TLDR deck) / 3 (Listen) | |
| `parseHash`, `App` hash routing | Next routes + `components/site/LegacyHashRedirect.tsx` | 1 / 2 | div. 1 |
| `fmtDate` | `lib/format-date.ts` | 1 | site timezone |
| `nextArticle` | `server/public/articles.ts` | 1 | div. 24 |
| `titleFor` | `generateMetadata` (`<Title> — log0`, home = `log0`) | 1 / 2 (OG) | |
| Retired: margin notes, `AnnotationLayerLegacy`, `Reactions`, `TldrPanel`, `FeaturedRotator`, `SentenceBuilder`, `GoDeeper`, `PullQuote`, `WordCloud`, `Tiers`, `ExpandCard`, `Thumb`, `DeckPoll`, search | not ported | — | div. 5, 21, 22 |

## 3. Public screens

### Chrome (`app/(site)/layout.tsx`) — Phase 1
`<div id="blog0-root">` → `Masthead` (wordmark types in on the page clock, last char spins
forever unless reduced motion; tagline types after 480 ms; compacts after 56 px scroll with
hysteresis) → page → `Footer` (ASCII canvas, newsletter, topics, contact mail, icons,
"> end of log0" typed on view, `© <year> log0 | smallTech`). `PrintIn` runs on every pathname
change. Theme toggle flips `data-theme` and (Phase 2) persists.

### Home `/`
- Phase 1: `.col` with `StubNotice` ("Featured and About arrive in Phase 2") then the **Latest**
  `.home-sec` listing all published articles newest first as `PostCard` (variant `post`), quick
  **TLDR** button only when a published deck exists (navigates to `/p/<slug>/tldr`), **Listen**
  hidden. Empty state: "Nothing published yet." plus, when signed in, a link to the desk.
- Phase 2: exactly the design `Home`: About section (`Typewriter` heading "About Us",
  strap/stand/body typed on the shared clock), **Featured Editorial** pinned head + scroll stack of
  up to 4 `card-lead` cards, **Latest** (non-featured) with **See More** (batches of 5, 280 ms) and
  **View all articles**; "That’s everything in the feed." when exhausted. Card TLDR opens the deck
  overlay (data from `GET /api/public/articles/:slug/tldr`; loading = button disabled with `…`;
  error = the button shows "Couldn’t load" for 2 s).

### Article `/p/<slug>` (+ `/tldr`, Phase 3 `/listen`) — Phase 1
`main.modeframe` → `.artwrap` → `.modebar` (mode label · title · X: Read → back to `/`;
Listen → back to Read) → Read: `.readhead` (tag, in-progress badge "Draft — in progress",
byline `<b>author</b> | date`, `SplitHeadline` h1, `Dek`, rule) → `.readbody` → `ArticleBody`
(html blocks in `.prose` + figure components) → `.artfoot` (in-progress note copy from design when
flagged; Phase 2 Share article button; "Next: <title> →"). `.modedock` capsule at viewport bottom:
Read (`readMinutes`), TLDR (`tldrMinutes` of published deck; **disabled** with title "No summary
yet" when no published deck), Listen ("—", opens `ListenStub` in Phase 1–2).
- **TLDR deck**: opening sets URL `/p/<slug>/tldr` via `history.replaceState`; closing (X, Esc,
  Read) returns to `/p/<slug>`; loading `/p/<slug>/tldr` directly opens it. Slides =
  `[{kind:'intro', text: title, sub: dek}]` + one per published line. Intro slide adds
  `<p class="tdeck__note">` with the disclosure (div. 8). Eyebrow = `topic · date · N min read`.
  End slide: **Read the full article** + `ShareLinkButton` (copies the absolute `/p/<slug>/tldr`
  URL). All gestures/timings exactly as design (auto-advance with dwell, pause/play, segment
  click, wheel accumulation + rubber band, touch drag + snap, keys ←/→/↑/↓/PgUp/PgDn/Home/End/Esc,
  body scroll lock + scroll restore, deck starts under the measured header).
- Unknown/unpublished slug → `not-found.tsx` in the site chrome: "That article isn’t here." +
  link home.

### Archive `/archive`, About `/about`
Phase 1: page header + `StubNotice`. Phase 2: design `Archive` (month groups, topic pills, empty
"Nothing filed under that topic yet.") and `About` (`About <wordmark>` h1, stand, strap, body).

### Paragraph share (Phase 2)
Hover on `.para` (pointer devices) → `additions.css` shows a 2 px `--accent` rule in the left
gutter. Click/tap on a paragraph (ignoring clicks on `a`, `button`, figures) or a selection of
≥ 3 chars inside one paragraph → `.para.is-hl` + `.hlmenu` placed like the design's `placeFor`;
status line "Copying…" → "Copied, with a link to this passage" / "Clipboard unavailable here —
share below instead"; grid: LinkedIn (`https://www.linkedin.com/sharing/share-offsite/?url=<link>`),
X (`https://x.com/intent/tweet?text=<“quote”>&url=<link>`), Copy link; foot "No sign-in needed."
Link = `<publicBase>/p/<slug>#<pid>`; URL updated with `replaceState`. Loading a URL with
`#p-…` scrolls the paragraph to centre and highlights it (menu closed). Close on outside click,
Esc, scroll (highlight stays).

### Listen (Phase 3)
Design `listenview` frame: tag, h1, player (`.audio` styles: play/pause, range seek, times) on
the left/top; the article text alongside (≥ 960 px: two columns; narrower: player sticky on top)
with the current paragraph `.para.is-live` (accent-soft fill) auto-scrolled to centre (paused for
4 s after the reader scrolls manually). Keyboard: Space play/pause, ←/→ ±5 s. Paragraph click →
seek to its cue.

## 4. Admin screens

All admin pages import `src/styles/admin.css` and reuse design tokens/components. Header bar
(`DeskHeader`): small wordmark "log0 · desk", links Desk (Phase 2 + Site, Subscribers; Phase 4 +
AI usage, Team), user name, **Sign out**.

### Sign in `/admin/login` (S1.1)
Centered `.surface` card: wordmark, "Sign in to the desk", Email, Password (labels, autocomplete),
primary button **Sign in** (disabled + "Signing in…" while pending). Errors inline under the form:
"Email or password is incorrect." / "Too many attempts — try again in N minutes." Success →
`next` param or `/admin`. Already signed in → redirect to `/admin`.

### Desk `/admin` (S1.5)
Title "Desk", primary **New article**. Table (`ArticleTable`): Title (link to editor) · Topic ·
Status pill (Draft / Submitted / Approved / Published, plus "· unpublished changes") · Format
chips (`FormatChips`: Read ✓, TLDR `missing|generating|ready|stale|failed`, Listen
`later phase` greyed in Phases 1–2) · Updated (relative time, by name). Empty: "No articles yet.
Paste your Markdown and see it exactly as readers will." + **New article**. Load error: inline
message + **Retry**.

### New article `/admin/articles/new`
Form: Title (required), Topic (datalist), Dek, Markdown (optional) → **Create** → POST → redirect
to the editor.

### Editor `/admin/articles/[id]` (S1.5)
- **Top bar (`PublishBar`)**: ← Desk · title · save state ("Saved · rev 3" / "Unsaved changes" /
  "Saving…" / "Couldn’t save — Retry") · **Save** (Cmd/Ctrl+S) · **Publish** / **Publish
  changes** (disabled while unsaved; shows blocking reasons in a popover from `PUBLISH_BLOCKED`) ·
  **View live ↗** when published · menu: Unpublish (confirm), Delete draft (confirm, only never
  published). `beforeunload` guard when dirty. A 409 `CONFLICT` shows "Someone saved a newer
  version (rev N by X). Reload to continue." with **Reload**.
- **Tabs**: Write · TLDR · Listen · History. Listen = `StubNotice` "Upload a word-for-word reading
  and tap along to sync — Phase 3". History = `StubNotice` "Every save is already kept (N
  revisions). Browsing and restoring arrives in Phase 4."
- **Write tab**: fields Title, Dek, Topic; **Settings** disclosure: Slug (locked note after
  publish), Byline, Featured (toggle + rank), "Show ‘Draft — in progress’ badge". Split view ≥
  1100 px: `MarkdownEditor` (monospace textarea, Tab inserts 2 spaces, word count) left; **Live
  preview** right rendered with the real `ReadHead` + `ArticleBody` inside `.readbody` (same CSS
  as public). < 1100 px: Write/Preview toggle. Preview states: "Updating…" indicator (no flicker:
  keep the last render until the new one arrives), warnings list above it (unknown figure, raw
  HTML dropped, unknown code language), empty body → "Start typing Markdown — the preview appears
  here."
- **TLDR tab (`TldrTab`)**:
  - Header: status chip, bounds hint "Jev will pick 5–7 lines for this length", primary
    **Generate with Jev** (or **Regenerate**; confirm "Replace your current deck with Jev's new
    picks?" when a draft exists). Unsaved changes → button label "Save & generate" (saves then
    generates). Disabled with reason when 0 eligible sentences.
  - Running: button spinner "Jev is reading…" with elapsed seconds; panel keeps prior deck
    visible but dimmed.
  - Generation meta line (latest): "Jev · <model> · <promptVersion> · <tokens> tokens · $<cost
    to 4 dp> (or ‘cost n/a’) · <name> · <relative time>".
  - Failure card: "Jev couldn’t make a deck: <message>." **Try again** · "or pick lines yourself
    from the article on the right."
  - Two columns: **Deck** (ordered cards: ordinal `01`, line text, reason in italic "Jev: …" or
    "Added by you", ↑ ↓ ✕ buttons with aria-labels, `missing` lines flagged in accent with
    "No longer in the article") and **Article lines** (eligible sentences grouped under their
    heading path; checkbox per line; checking inserts it at its document-order position among
    deck lines that are still in document order, otherwise appends; unchecking removes).
  - Footer: **Save deck** (dirty indicator), **Preview deck** (opens the real `TldrDeck` over
    the editor with the current draft), **Reset to Jev’s picks** (when a generation exists),
    **Clear deck** (confirm).
  - Empty: "No deck yet. Jev reads the saved article and picks 4–8 lines, word for word. One
    call, usually under a cent."

### Later admin screens
Site settings (P2: form for tagline, contact email, About strap/stand/body, social URLs with live
preview of the About block), Subscribers (P2: count, table, **Export CSV**), Listen tab (P3:
upload dropzone with progress, player, paragraph list; **Start syncing** → plays from 0,
highlights next paragraph, **Space**/big button records its cue; **Undo last tap** (Backspace),
**Restart**; per-paragraph nudge ±0.25 s; **Save sync**), History tab (P4: list, view rendered,
**Restore**), Stale banner (P4), AI usage (P4: month picker, total, table), Team (P4).

## 5. CSS additions (`src/styles/additions.css`) — only new rules, tokens only

- Font variable wiring (porting rule 5).
- `.para` hover gutter rule; `.para.is-hl` (same as `.sent.is-hl`); `.para.is-live` (Listen).
- `.prose table` (wrap in `.tablewrap`-like overflow container via `.prose .table-scroll`;
  cells styled like `table.data`), `.prose code` inline (mono 0.9em, `--surface-2` bg, 2 px
  radius), `.prose pre.shiki` (mono 14.5px, 16 px padding, `--border` 1 px, 4 px radius, overflow
  auto) with dual-theme switch: `[data-theme="dark"] .shiki, [data-theme="dark"] .shiki span {
  color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; }` and
  light equivalent with `--shiki-light`.
- `.prose .footnotes` (top rule, smaller type 15.5px, label `h2.footnotes-label` styled as
  `.prose h2` and visible — the design's "Notes"), `sup a` accent ink, back-references.
- `.prose del`, task-list checkbox alignment, `.mdfig`/`.mdimg` already exist.
- `.stub` (`StubNotice`): dashed `--border-strong` 1 px, `--surface` bg, 14 px 18 px padding,
  `--font-head` 14.5px `--muted`, leading label "Coming in a later phase" in `--accent-ink` 600.
- `.mode:disabled` (opacity .45, cursor not-allowed) — the design references disabled modes.

## 6. Accessibility & states checklist (every screen)

Empty, loading, error and populated states as written above; all controls are real
`<button>`/`<a>`/`<label>`; focus-visible ring from the design; deck is `role=dialog`
`aria-modal`, slide changes announced (`.sr` live region "Slide n of m"); capsule is a
`role=tablist`; reduced motion disables typing, spins, print-in, deck transitions (design rules).
