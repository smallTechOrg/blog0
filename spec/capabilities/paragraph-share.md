# Capability: Share — paragraph, article, deck

Phase 2. Unit = paragraph (design divergence 2); targets and surfaces per divergence 3 (user
decision: all options, native sheet on touch). Screen markup: `spec/ui.md` §3 *Share*.

## What It Does
Lets a reader share a paragraph (or a selection inside it), the whole article, or the TLDR deck to
LinkedIn, X, WhatsApp, Notes (mail), Notion or as a copied link — through the phone's native share
sheet on touch devices and an expandable menu on desktop — with the text and a deep link copied
automatically; opening a paragraph link scrolls to and highlights that paragraph.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Paragraph click/tap or text selection inside one paragraph | gesture | reader | one of these |
| **Share article** button at the article foot | click | reader | |
| **Share** on the deck end slide | click | reader | |
| Paragraph deep link | `/p/<slug>#p-xxxxxxxx` | URL | for deep links |
| Site brand | `blog0` | site record | yes |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Highlight | paragraph tinted (`.para.is-hl`) | page |
| Clipboard text | see *Share texts* | reader clipboard |
| Native share sheet | `{ title: 'blog0', text, url }` | OS (touch/narrow screens) |
| Share menu | status line + LinkedIn, X, WhatsApp, Notes, Notion, Copy link | page popover (desktop, or fallback) |
| Address bar | updated to the paragraph link (no new history entry) | browser |

## Share texts (one source: `src/lib/share-links.ts`, pure)
Let `B = 'blog0'`, `Q = “<quote>”` (curly quotes U+201C/U+201D), links absolute from the public base.

| Subject | `text` | `link` | Clipboard (auto-copied) |
|---|---|---|---|
| paragraph / selection | `Q — B` | `/p/<slug>#<pid>` | `text + '\n' + link` |
| article | `<title> — B` | `/p/<slug>` | `text + '\n' + link` |
| deck | `<title> — TLDR — B` | `/p/<slug>/tldr` | `text + '\n' + link` |

Targets (`enc = encodeURIComponent`):

| Target | URL | Opens |
|---|---|---|
| LinkedIn | `https://www.linkedin.com/sharing/share-offsite/?url=${enc(link)}` (LinkedIn ignores text) | new tab |
| X | `https://x.com/intent/tweet?text=${enc(text)}&url=${enc(link)}` | new tab |
| WhatsApp | `https://wa.me/?text=${enc(text + ' ' + link)}` | new tab |
| Notes | `mailto:?subject=${enc('Saved from ' + B)}&body=${enc(text + '\n\n' + link)}` | same tab (mail handler) |
| Notion | `https://www.notion.so/` (no prefill API; the text is on the clipboard) | new tab |
| Copy link | copies `link` only; label "Link copied" for 1.8 s | — |
| Native sheet | `navigator.share({ title: B, text, url: link })` | OS |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Browser clipboard | write text | status "Clipboard unavailable here — share below instead"; share options still work |
| `navigator.share` | open sheet | `AbortError` → nothing; other errors / API absent → the menu opens |

## Business Rules
- Touch/narrow (`navigator.share` present AND (`(pointer: coarse)` OR viewport < 720 px)) prefers
  the native sheet; desktop always shows the menu with the visible "Copied…" status.
- Clicks on links, buttons and interactive figures never trigger highlighting.
- A selection of fewer than 3 characters is ignored; a selection spanning paragraphs highlights
  the paragraph where it starts and shares the selected text with that paragraph's link.
- Paragraph ids are stable across unrelated edits (content-derived), so shared links survive
  edits to other paragraphs; a link to a paragraph that no longer exists just opens the article.
- One highlight at a time; clicking the highlighted paragraph again clears it and closes the menu.
- The menu closes on outside click, Escape, or scroll; the highlight remains. The deck's menu
  closes without closing the deck.
- Paragraph sharing works in Read view; the deck end slide shares the deck; both share texts
  carry the brand `blog0`.
- Share URLs are the only place the brand appears in outgoing text; the brand is read from the
  site record, never hard-coded in `share-links.ts` (passed as an argument).

## Success Criteria
- [ ] Unit (`tests/unit/reader/share-links.test.ts`): for each subject kind and target, the built URL/text equals the table above exactly (fixtures include a quote with `&`, `#`, an apostrophe and an emoji; the X text is `“…” — blog0`).
- [ ] In Chromium (clipboard permission granted): clicking a paragraph adds `.is-hl`, the clipboard contains `“<paragraph text>” — blog0` + newline + a link ending `#<that paragraph's id>`, and the menu shows "Copied, with a link to this passage" and six options in the order LinkedIn, X, WhatsApp, Notes, Notion, Copy link.
- [ ] In Chromium with a mobile emulation (touch, 390 px) and a stubbed `navigator.share`: tapping a paragraph calls `navigator.share` once with `{ title: 'blog0', text, url }` and no `.hlmenu` is rendered; with the stub rejecting (`new Error('x')`) the `.hlmenu` opens instead.
- [ ] **Share article** copies `<title> — blog0\n<article url>` and opens the menu; the deck end-slide Share copies `<title> — TLDR — blog0\n<deck url>` and opens the menu inside the open deck; Escape closes only the menu.
- [ ] Clicking a link inside a paragraph navigates/opens without highlighting.
- [ ] Opening `/p/<slug>#<pid>` in a fresh page scrolls that paragraph into view with `.is-hl` and no open menu.
- [ ] Editing a different paragraph and republishing keeps the old `#<pid>` link working.
