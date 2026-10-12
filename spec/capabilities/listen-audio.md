# Capability: Listen — audio upload, storage, streaming, player

Phase 3. Paragraph timing (estimated by default) and the reader highlight/follow are
`listen-sync`; inline images share the storage and the `/media/` route (`media-images`). HOW
(storage interface, `/media/[...key]` route, probe libraries, limits): `spec/architecture.md` §9.
Screens: `spec/ui.md` §3 *Listen* and §4 *Listen tab*. Data: `spec/data.md` → `article_format`
(`listen` payload) and `media_asset`. HTTP: `spec/api.md` → Listen + media.

## What It Does
Lets a writer attach a word-for-word reading (mp3 or m4a) to an article, stores it on local disk
behind the storage interface, streams it with HTTP range requests, and gives readers a real
player — on the article's Listen view, in the home-card overlay, and as the capsule's
"Listen · N min".

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Audio file | `audio/mpeg` (mp3) or `audio/mp4` (m4a/AAC); ≤ `BLOG0_MAX_AUDIO_MB` (50) MB; ≤ `BLOG0_MAX_AUDIO_MINUTES` (30) | editor Listen tab (file picker or drop) | yes |
| Replace / remove | click | editor Listen tab | no |
| Range requests | `Range: bytes=…`, `If-None-Match`, `If-Range` | any player (reader, editor, card overlay) | no |
| Playback controls | play/pause, seek, Space, ←/→ | reader | no |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Stored audio | file under `BLOG0_STORAGE_DIR` at key `<siteSlug>/audio/<yyyy>/<mm>/<uuid>.<mp3\|m4a>` | storage |
| Media record | `media_asset` row: kind `audio`, mime, bytes, sha256, `duration_sec` (= `durationMs / 1000`), original filename, uploader | database |
| Listen draft | `article_format(kind='listen').draft_payload` = `{ audio, marks: [], syncFingerprint: null, uploadFingerprint: <current revision's paragraphs fingerprint> }` | database |
| Listen status | `ready` right after upload; later `text_changed` (non-blocking warning) if the paragraph text changes (`spec/architecture.md` §5) | desk chip, editor tab chip |
| Stream | 200 / 206 / 304 / 416 responses with `Content-Type`, `Accept-Ranges`, `Content-Range`, `ETag`, `Cache-Control` | every player |
| Durations | `times.listen = max(1, round(durationMs / 60000))` (design `audioMinutes`) | capsule, cards, deck capsule, OG-free |
| Log lines | `media.upload`, `media.request` | structured log |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Local disk (storage interface) | write temp → fsync → rename; stat; stream a byte range; delete | upload answers 500 `INTERNAL` with "Couldn't store the file" and leaves **no** `media_asset` row and no temp file; streaming a vanished file answers 404 |
| Database | insert `media_asset`, upsert the Listen draft (one transaction) | the already-written file is deleted again (no orphan on disk, no orphan row) |
| Audio probe (in-process, pure JS) | container + codec detection and duration of the uploaded bytes | unreadable / unknown container → 415 `UNSUPPORTED_MEDIA`; readable but no duration → 415 with "Couldn't read the recording's length" |

## Business Rules
- **Validated by content, never by extension or the browser's `Content-Type`.** Accepted: MPEG
  audio layer III (`audio/mpeg`, stored ext `mp3`) and MPEG-4 audio with AAC or ALAC (`audio/mp4`,
  stored ext `m4a`). Anything else — including WAV, OGG, a renamed text file, an MP4 with a
  video track — → 415 `UNSUPPORTED_MEDIA` with the detected type in the message.
- Size over the limit → 413 `PAYLOAD_TOO_LARGE` (message states the limit in MB); the check runs
  on the declared `Content-Length` before reading and again while reading (so a lying client
  cannot exceed it). Duration over `BLOG0_MAX_AUDIO_MINUTES` → 422 `AUDIO_TOO_LONG` with both
  values in the message. Limits are read from config at request time (tests lower them via env).
- **Upload ⇒ `ready` immediately.** The upload records `uploadFingerprint` = the saved current
  revision's paragraphs fingerprint (the text the recording is assumed to read). There is no sync
  step; timing is estimated at read time (`listen-sync`).
- **Text-changed warning (never blocking).** When the current revision's paragraphs fingerprint
  differs from the draft's `uploadFingerprint` (any paragraph's text edited, added, removed or
  reordered after the upload), the Listen status is `text_changed`: the chips show a warning and
  the Listen tab says "The recording may no longer match the text". Publishing is **never**
  blocked by Listen. Heading-, code- or table-only edits don't change the paragraph fingerprint
  and leave `ready`; reverting the text clears the warning; uploading a new recording re-baselines
  it. > **Assumed:** there is no "keep this recording anyway" dismiss in v0.1 — the warning
  persists until re-upload or revert (it never blocks anything).
- Uploading a new file **replaces the draft audio and clears its stored marks** (no confirm —
  there is no writer-made sync to lose). The previously **published** Listen (its own audio key)
  keeps serving until the next successful publish. The storage key is unique per upload
  (uuid), so caches never see a changed body under the same URL.
- **Publishing** copies the Listen draft (whatever its status) to the published copy; with no
  draft (after **Remove audio**) publishing clears the published Listen.
- **Remove audio** clears the Listen draft (status → `missing`); the published Listen keeps
  serving until the next publish, at which point Listen is no longer offered.
- An audio file is deleted from storage only when neither the draft nor the published payload of
  any article references its key (replacement, removal, publish). Media rows whose file is
  gone are never recreated. Unreferenced files are otherwise never collected (v0.1).
- `/media/<key>` is public and unauthenticated (keys are unguessable uuids); it serves exactly
  what `media_asset` says: the stored `mime_type` (never sniffed), `Accept-Ranges: bytes`,
  `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<sha256>"`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, and supports `GET` and
  `HEAD`. One byte range per request (`bytes=a-b`, `bytes=a-`, `bytes=-n`); unsatisfiable →
  416 with `Content-Range: bytes */<size>`; multiple ranges → ignored (200 full body);
  `If-None-Match` equal → 304; `If-Range` present and different from the ETag → 200 full body.
  Keys that fail validation (`spec/architecture.md` §9: traversal, absolute, bad charset,
  unknown extension) → 404 `NOT_FOUND`, never a filesystem lookup. Keys not in `media_asset` for
  the current site → 404.
- Draft audio is playable in the editor through the same route (the Listen tab's preview player
  uses `audio.url` from `ListenStateDto`).
- The reader's player is the design `AudioPanel` markup bound to a real `<audio
  preload="metadata">` (`spec/ui.md` §3 *Listen*): play/pause, seek range, `m:ss` clocks via
  the design's `fmtClock`, keyboard Space (play/pause) and ←/→ (±5 s) per `listen-sync`. The
  `.audio__note` reads "Read by <byline> · N min" instead of the design's placeholder text.
- Listen is offered to readers (capsule enabled, card button shown, deck's Listen enabled,
  `/p/<slug>/listen` served) **only** when the article is published and its published Listen
  payload exists; otherwise the capsule's Listen — and the TLDR deck's mode-switcher Listen,
  with identical copy — is disabled with `title="No recording yet"` and
  `aria-label="Listen — no recording yet"` (divergence 9, decided) and `/p/<slug>/listen` renders
  the article in Read mode at `/p/<slug>`.
- `times.listen` everywhere (capsule, cards, deck capsule, public DTOs) is the published
  recording's minutes — never the draft's.
- Designer mode needs nothing new: the default storage dir `./var/storage` is created on first
  write; uploads and streaming work on PGlite exactly as on Postgres.

## Success Criteria
- [ ] Integration (`tests/integration/audio-ingest.test.ts`): uploading `tests/fixtures/audio/sample.m4a` as admin returns 200 with `listen.status === 'ready'`, `listen.uploadFingerprint` equal to the current revision's `paragraphs_fingerprint`, `listen.timing === 'estimated'`, `listen.audio.mimeType === 'audio/mp4'`, `listen.audio.durationMs` within ±500 ms of `sample.json`'s recorded value, `listen.audio.bytes` equal to the file size; a file exists at `BLOG0_STORAGE_DIR/<audio.key>` with the same sha256 as the fixture; one `media_asset` row exists with `kind='audio'` and `round(duration_sec × 1000)` equal to the DTO's `durationMs`; uploading `sample.mp3` yields `mimeType 'audio/mpeg'` and a key ending `.mp3`.
- [ ] A 1-byte text file named `song.mp3` with `Content-Type: audio/mpeg` → 415 `UNSUPPORTED_MEDIA`; `not-audio.wav` → 415; with the size limit set to 1 MB (`BLOG0_MAX_AUDIO_MB=1` through the config reset helper) a 1.1 MB random buffer → 413 `PAYLOAD_TOO_LARGE` with no `media_asset` row and no file under the storage dir; with the duration limit injected as 10 000 ms (`uploadAudio(…, { limits: { maxBytes, maxDurationMs: 10_000 } })` — the route passes the config values, the test passes its own) `sample.m4a` (~20 s) → 422 `AUDIO_TOO_LONG`, no row, no file.
- [ ] Uploading a second file for the same article replaces `audio.assetId`, clears `marks` (`[]`), and the first file is deleted from disk (it was unpublished); the first `media_asset` row is deleted. `DELETE …/audio` → `status 'missing'`, `audio: null`, file deleted, row deleted.
- [ ] Text-changed warning (`tests/integration/listen-sync.test.ts`): after upload, editing one paragraph's text and saving → `status 'text_changed'`, `textChangedSinceUpload true`, the desk `listen` chip status `text_changed`; publish → **200** (no `PUBLISH_BLOCKED`, no Listen reason) and the public Listen serves the new audio with estimated marks over the new text; editing only a heading → `status` stays `ready`; reverting the paragraph → `ready`; uploading again after the edit → `ready` with the new `uploadFingerprint`.
- [ ] After publishing a Listen, uploading a new file keeps the published payload (`published.durationMs` unchanged) and the published file on disk; the public article still streams the old key; after `DELETE …/audio` + publish, `/p/<slug>` has `times.listen === null` and the old file is deleted.
- [ ] Integration (`tests/integration/media.test.ts`), against real stored files: `GET /media/<key>` → 200, `Content-Length` = size, `Accept-Ranges: bytes`, `ETag: "<sha256>"`, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, correct `Content-Type`; `Range: bytes=0-1023` → 206, `Content-Range: bytes 0-1023/<size>`, body exactly the first 1024 bytes of the file; `Range: bytes=-100` → 206 with the last 100 bytes; `Range: bytes=<size>-` and `bytes=999999999-` → 416 with `Content-Range: bytes */<size>`; `If-None-Match: "<sha256>"` → 304 empty body; `HEAD` → 200 with the same headers and no body.
- [ ] `/media/..%2F..%2Fetc%2Fpasswd`, `/media/%2Fetc/passwd`, `/media/blog0/audio/2026/10/x.exe`, and a well-formed key with no `media_asset` row → 404 `NOT_FOUND` (JSON envelope) and no `error` log line.
- [ ] Public queries: a published article with a published Listen has `times.listen === max(1, round(durationMs/60000))` on the article page, in `PostCardViewModel`, in `GET /api/public/articles/:slug/tldr` and in `GET /api/public/articles/:slug/listen`; a published article with only a draft Listen has `times.listen === null` everywhere.
- [ ] E2E (`tests/e2e/listen.spec.ts`, Chromium): on a published article with Listen, the capsule reads `Listen` + `N min`; clicking it shows `section.listenview` with a `.audio` player whose `<audio>` has `src` ending in `.mp3`, pressing the play button advances `audio.currentTime` past 1 s within 3 s; `/media/<that key>` answers 206 to `Range: bytes=0-1`. On a card, **Listen** opens the `.sheetfull` overlay with the same player and the address bar is unchanged.
- [ ] Designer-mode E2E (`tests/e2e/designer-mode.spec.ts`): the same upload → stream round trip succeeds on PGlite with no `BLOG0_STORAGE_DIR` set (files land in `./var/storage`).
