# Capability: Listen — audio upload, storage, streaming, player

Phase 3. Sync is `listen-sync`.

## What It Does
Lets a writer attach a word-for-word reading of the article and lets readers play it with
seeking, streamed efficiently.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Audio file | mp3 (audio/mpeg) or m4a (audio/mp4), ≤ 50 MB (`BLOG0_MAX_AUDIO_MB`), ≤ 30 min (`BLOG0_MAX_AUDIO_MINUTES`) | editor Listen tab | yes |
| Range requests | `Range: bytes=…` | reader's player | no |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Stored audio | file on local disk behind the storage interface + media record (size, sha256, duration) | storage, database |
| Listen draft | audio reference + duration (cues empty) | database |
| Stream | 200/206 byte responses with correct headers | reader/editor player |
| Capsule/Card durations | minutes from the recording | reader site |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Local disk (storage interface) | write temp → rename, read ranges, delete | upload fails with a clear message; no orphan media record |
| Database | media + listen format rows | as above |

## Business Rules
- Files are validated by content (probe), not by extension: wrong type → 415, too big → 413, too
  long → 422 with the limit stated.
- Uploading a new file replaces the draft audio and clears its cues; the published audio keeps
  serving until the next publish.
- Media is served with `Accept-Ranges: bytes`, correct `Content-Type`, long immutable caching
  (keys are unique), `nosniff`.
- The capsule's Listen duration is the recording's length; Listen is offered to readers only
  when the published Listen format is ready.

## Success Criteria
- [ ] Uploading `tests/fixtures/audio/sample.m4a` stores a file under `BLOG0_STORAGE_DIR`, a `media_asset` with duration within ±0.5 s of the fixture's known length, and Listen status `needs_sync`.
- [ ] A 1-byte text file renamed `.mp3` → 415; a file over the size limit (limit lowered via env in the test) → 413.
- [ ] `GET /media/<key>` with `Range: bytes=0-1023` → 206, `Content-Range: bytes 0-1023/<size>`, 1024 bytes; without Range → 200 full size; `Range: bytes=999999999-` → 416.
- [ ] A path-traversal key (`/media/..%2F..%2Fetc%2Fpasswd`) → 404.
