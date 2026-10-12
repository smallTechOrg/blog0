# Capability: Paragraph highlight & share

Phase 2. Unit = paragraph (design divergence 2); share targets per divergence 3.

## What It Does
Lets a reader highlight any paragraph, which copies its text with a deep link and offers sharing
to LinkedIn and X; opening that link scrolls to and highlights the paragraph.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Paragraph click/tap or text selection inside one paragraph | gesture | reader | yes |
| Paragraph deep link | `/p/<slug>#p-xxxxxxxx` | URL | for deep links |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Highlight | paragraph tinted | page |
| Clipboard text | `“<paragraph text>” — log0` newline `<absolute link>` | reader clipboard |
| Share menu | status line + LinkedIn, X, Copy link | page popover |
| Address bar | updated to the paragraph link (no new history entry) | browser |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Browser clipboard | write text | status "Clipboard unavailable here — share below instead"; share options still work |

## Business Rules
- Clicks on links, buttons and interactive figures never trigger highlighting.
- A selection of fewer than 3 characters is ignored; a selection spanning paragraphs highlights
  the paragraph where it starts and shares the selected text.
- Paragraph ids are stable across unrelated edits (content-derived), so shared links survive
  edits to other paragraphs; a link to a paragraph that no longer exists just opens the article.
- One highlight at a time; clicking the highlighted paragraph again clears it and closes the menu.
- The menu closes on outside click, Escape, or scroll; the highlight remains.
- Works the same in Read view; not in the TLDR deck.

## Success Criteria
- [ ] Unit: share URLs are built exactly — LinkedIn `https://www.linkedin.com/sharing/share-offsite/?url=<encoded link>`, X `https://x.com/intent/tweet?text=<encoded “quote”>&url=<encoded link>`.
- [ ] In Chromium (clipboard permission granted): clicking a paragraph adds `.is-hl`, the clipboard contains the quoted text and a link ending `#<that paragraph's id>`, and the menu shows "Copied, with a link to this passage".
- [ ] Clicking a link inside a paragraph navigates/opens without highlighting.
- [ ] Opening `/p/<slug>#<pid>` in a fresh page scrolls that paragraph into view with `.is-hl` and no open menu.
- [ ] Editing a different paragraph and republishing keeps the old `#<pid>` link working.
