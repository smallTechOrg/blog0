# Capability: Media library (images)

Follows `media-images` (uploads) and shares its storage, `media_asset` table and `/media/[...key]`
route (HOW: `spec/architecture.md` §9). Screen: `spec/ui.md` §4 *Media*.

## What It Does
One place to see every image uploaded to the blog, which articles show each one, and to replace an
image's file — without touching any article.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Replacement file | PNG, JPEG, WebP or GIF, same limits as an upload (≤ `BLOG0_MAX_IMAGE_MB`, ≤ 12 000 px) | Replace… on an image card | for a replace |
| Image id | uuid of an image `media_asset` of this site | route param | for a replace |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Library | `GET /api/admin/media` → `{ items: MediaLibraryItemDto[] }`: id, key, url (`/media/<key>`), filename, mimeType, bytes, width, height, createdAt, uploadedBy, `usedIn` (articles) — images only, newest upload first | Admin → Media |
| Replaced image | `POST /api/admin/media/:id/replace` → `{ item }`; new bytes stored under the SAME key; row updated (mime, bytes, sha256, width, height, filename) | storage, database |
| Log lines | `media.replace`, `media.upload` (`op: replace`) | structured log |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Image probe (in-process) | type + dimensions of the new file | not an allowed image (incl. SVG) → 415; over 12 000 px → 422 |
| Storage + database | put under the existing key (atomic), then update the row | the old bytes are put back; the writer sees an error and nothing changed |

## Business Rules
- **Usage** = articles whose CURRENT or PUBLISHED revision's Markdown contains `/media/<key>`
  (plain substring match). Each shows its current title and `draft` / `published`, newest edited first.
  Formats (TLDR decks, Listen) do not reference images.
- **Replace keeps the address.** The key, and so every `/media/<key>` in every article and revision,
  is unchanged; readers get the new file on their next view because images are revalidated
  (`Cache-Control: public, no-cache`, ETag = the new sha256). The replacement may be a different
  image type than the original: the served `Content-Type` is the row's.
- The render cache (which embeds each image's width/height) is cleared on replace, so pages
  never use the old size. A replacement with other dimensions changes the layout of the article.
- Audio recordings are not listed here (they belong to an article's Listen tab). There is no delete:
  an image no article uses stays in the library (and in the nightly backup).
- Same auth as every admin API: no session → 401; cross-origin write → 403.

## Success Criteria
- [ ] Integration (`tests/integration/media-library.test.ts`): `GET /api/admin/media` lists two uploaded images newest first with `uploadedBy` and `usedIn` (the article whose body links the first image, status `draft`), lists nothing for audio, and answers 401 without a session.
- [ ] Replacing `sample.png` with `sample.jpg` returns 200 with the SAME `key`/`url` and the JPEG's mime, size and dimensions; `GET /media/<key>` then returns the JPEG bytes with `content-type: image/jpeg`, a different ETag and `cache-control: public, no-cache`; the article still lists as using it; the render cache is empty afterwards.
- [ ] SVG → 415 `UNSUPPORTED_MEDIA`; a non-image → 415; no file → 400; unknown / malformed id → 404; no session → 401; cross-origin → 403 — and after every refusal the old file and row are unchanged.
- [ ] E2E (`tests/e2e/media.spec.ts`): after pasting an image into an article and saving it, Admin → Media shows its card ("PNG", the article's title); choosing `sample.jpg` and confirming Replace turns the card into "JPEG" / "sample.jpg" and `GET <same address>` returns the JPEG bytes.
