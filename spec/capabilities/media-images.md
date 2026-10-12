# Capability: Inline images upload

Phase 3.

## What It Does
Lets a writer upload an image from the editor and inserts the Markdown that shows it inline in
the article.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Image file | png, jpeg, webp, gif ≤ 8 MB (`BLOG0_MAX_IMAGE_MB`) | editor Image button (file picker or drop) | yes |
| Alt text | text ≤ 200 | prompt after choosing the file | yes (may be empty for decorative, with a warning) |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Stored image + media record (dimensions) | file + row | storage, database |
| Markdown snippet `![alt](/media/<key>)` inserted at the cursor | text | editor |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Storage interface / database | write file + record | inline error, nothing inserted |

## Business Rules
- Type detected from content; SVG is not accepted (script risk).
- The image renders in preview and publicly through the normal Markdown rules (alone on a line →
  captioned figure using the Markdown title).
- Images are never deleted automatically when Markdown stops referencing them (v0.1).

## Success Criteria
- [ ] Uploading a PNG returns a `/media/…` URL that serves 200 `image/png`, and the inserted Markdown renders a `figure.mdfig` in preview.
- [ ] Uploading an SVG → 415; an oversize file → 413.
