# Capability: Inline images upload

Phase 3. Shares the storage interface and `/media/[...key]` route with `listen-audio` (HOW:
`spec/architecture.md` §9). Rendering rules for images in Markdown are the content pipeline's
(`spec/architecture.md` §4 → `images` plugin). Screens: `spec/ui.md` §4 *Editor → Image*.

## What It Does
Lets a writer upload an image from the editor (toolbar button, file picker, or drag-and-drop
onto the Markdown area) and inserts the Markdown that shows it inline in the article.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Image file | PNG, JPEG, WebP or GIF, ≤ `BLOG0_MAX_IMAGE_MB` (8) MB, ≤ 12 000 px on either side | editor **Image** button (picker) or a file dropped on the editor | yes |
| Alt text | ≤ 200 chars | prompt after choosing the file (pre-filled from the filename without extension, `-`/`_` → spaces) | yes (may be left empty for decorative images; the editor shows a warning) |
| Caption | ≤ 200 chars | same prompt, optional | no |
| Article id | the editor's article | editor | no (recorded on the media row when present) |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Stored image | file at key `<siteSlug>/image/<yyyy>/<mm>/<uuid>.<png\|jpg\|webp\|gif>` | storage |
| Media record | `media_asset` row: kind `image`, mime, bytes, sha256, width, height | database |
| Markdown snippet | `![alt](/media/<key>)` or, with a caption, `![alt](/media/<key> "caption")` on its own line (blank lines around it) | inserted at the editor cursor (replacing the selection) |
| Log line | `media.upload` | structured log |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Image probe (in-process, pure JS) | type + dimensions from the bytes | unreadable / not in the allowlist (incl. SVG, BMP, TIFF, AVIF) → 415 `UNSUPPORTED_MEDIA` |
| Storage interface + database | write file, insert row (file first; row failure deletes the file) | inline error under the toolbar; nothing inserted into the Markdown |

## Business Rules
- Type is detected from the bytes; the extension and the browser's `Content-Type` are ignored.
  **SVG is never accepted** (script risk); animated GIF is accepted as-is (no re-encoding, no
  thumbnails in v0.1).
- Over the size limit → 413 `PAYLOAD_TOO_LARGE`; over 12 000 px → 422 `IMAGE_TOO_LARGE` (decoder
  safety; > **Assumed:** a generous cap that no article image reaches).
- The image renders in the live preview and publicly through the normal Markdown rules: alone on
  a line → `figure.mdfig` with the title as `figcaption`; inline → `img.mdimg`. Nothing special
  is rendered for `/media/` URLs — they are ordinary image URLs.
- Images are never deleted automatically when Markdown stops referencing them (v0.1); the
  storage key is unique per upload, so re-uploading the same file makes a new key.
- Several files dropped at once are uploaded one after another in drop order, each prompting for
  alt text, each inserted on its own line.
- Uploads run while the editor keeps working; the Markdown field stays editable and the inserted
  snippet goes where the cursor was when the upload started (position tracked through edits by
  offset shift; > **Assumed:** good enough for v0.1 — a concurrent edit before the insertion
  point only shifts the insertion).

## Success Criteria
- [ ] Integration (`tests/integration/media.test.ts`): uploading `tests/fixtures/images/sample.png` as admin returns 201 `{ asset: { id, url: '/media/<key>', key, mimeType: 'image/png', width, height, bytes }, markdown: '![sample](/media/<key>)' }` with the fixture's known dimensions; `GET` that URL → 200 `image/png` with the fixture's bytes; the `media_asset` row has `kind 'image'`, `width`/`height` set, `duration_sec` null, `article_id` = the given article.
- [ ] `sample.jpg`, `sample.webp`, `tiny.gif` → 201 with mime `image/jpeg`, `image/webp`, `image/gif` and keys ending `.jpg`, `.webp`, `.gif`; `sample.svg` → 415; a PNG renamed `.svg` → 201 as `image/png` (content wins); a text file named `.png` → 415; a 9 MB buffer with the default limit → 413 and no row/file; `alt` of 201 chars → 400 `VALIDATION_FAILED`.
- [ ] Unit (`tests/unit/admin/insert-image.test.ts`): the snippet builder yields `![a](u)` with no caption and `![a](u "c")` with one, escapes `"` in the caption as `\"`, and `insertAtCursor(value, start, end, snippet)` surrounds the snippet with blank lines only when the neighbours are not already blank.
- [ ] E2E (`tests/e2e/listen.spec.ts`): in the Write tab, setting the **Image** button's file input to `sample.png` and confirming the alt prompt inserts `![…](/media/…png)` at the cursor; the live preview then shows `figure.mdfig img` whose `naturalWidth` equals the fixture's width; after Save + Publish the public page serves the same figure.
