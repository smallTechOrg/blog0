# Capability: Backup and restore

Phase 5. HOW (modules, tool discovery, snapshot technique): `spec/architecture.md` → §12.3;
slices and gate: `spec/roadmap.md` → Phase 5.

## What It Does
One command captures a consistent backup of a blog0 deployment — the Postgres database, the
uploaded media files, and a manifest of what was captured — and a second command restores it into
a named database and storage directory, then proves the restore by comparing row and file counts
with the manifest.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| `--out <dir>` (backup) | directory; created if missing | CLI | yes |
| `--storage <dir>` (backup) | uploads directory | CLI, else `BLOG0_STORAGE_DIR`, else `./var/storage` | no |
| Source database | `BLOG0_DATABASE_URL` (`postgres://` only) | env / `.env` | yes |
| `--in <backupDir>` (restore) | one backup directory (`…/blog0-<UTC stamp>`) | CLI | yes |
| `--db <name \| postgres://url>` (restore) | target database; a bare name replaces the database name in `BLOG0_DATABASE_URL` | CLI | yes |
| `--storage <dir>` (restore) | target uploads directory | CLI | yes |
| `--force` (restore) | flag: replace a non-empty target DB / storage dir | CLI | no |
| `--check-only` (restore) | flag: skip restoring, only run restore-check of `--db` / `--storage` against the manifest | CLI | no |
| `pg_dump`, `pg_restore` (major ≥ the server's), `tar` | binaries on `PATH` | host | yes |

## Outputs
| Output | Type | Destination |
|---|---|---|
| `<out>/blog0-<yyyymmddTHHMMSSZ>/db.dump` | `pg_dump` custom format | disk |
| `<out>/blog0-<stamp>/storage.tar.gz` | gzip tar of the storage dir (omitted when it has no files) | disk |
| `<out>/blog0-<stamp>/manifest.json` | manifest (shape below), written last | disk |
| Backup summary | `backup: <dir>` / `db: <name> — <T> tables, <R> rows, dump <bytes>` / `storage: <N> files, <B> bytes`; last line = the backup dir | stdout |
| Restored database + storage dir | Postgres DB, files | target |
| restore-check report | one line per table `<table> <restored> / <manifest> ok\|MISMATCH`, `files <n> / <n> ok\|MISMATCH`, `bytes …`, then `restore-check: OK (<T> tables, <R> rows, <N> files)` or `restore-check: FAILED (<k> mismatches)` | stdout; exit 0 / 1 |

Manifest (`format: "blog0-backup/1"`):

```json
{
  "format": "blog0-backup/1",
  "createdAt": "2026-10-13T02:00:00.000Z",
  "appVersion": "0.1.0",
  "database": {
    "name": "blog0_dev", "serverVersion": "18.1",
    "migrations": { "applied": 2, "latest": "0001_rate_limit_bucket" },
    "tables": { "site": 1, "app_user": 2, "session": 3, "article": 6, "article_revision": 14, "article_format": 12, "ai_generation": 5, "newsletter_subscriber": 4, "media_asset": 3 },
    "excludedData": ["rate_limit_bucket"],
    "dumpFile": "db.dump", "dumpBytes": 123456, "dumpSha256": "<hex>"
  },
  "storage": { "files": 3, "bytes": 4567890, "archive": "storage.tar.gz", "archiveSha256": "<hex>" },
  "tools": { "pg_dump": "18.1" }
}
```
(`storage.archive` and `archiveSha256` are `null` when there are 0 files.)

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Postgres (source) | repeatable-read read-only transaction: export snapshot, count rows per table; `pg_dump --snapshot` | exit 1; the partial backup dir is removed |
| Postgres (target) | create the DB if missing; emptiness check; optional schema wipe (`--force`); `pg_restore`; recount | exit 1 with the reason (no automatic rollback of a partial restore — re-run with `--force`) |
| `pg_dump` / `pg_restore` / `tar` | spawned processes | missing binary → exit 1 "pg_dump not found on PATH — install the PostgreSQL 18 client tools (macOS: brew install postgresql@18; Debian/Ubuntu: apt install postgresql-client-18)"; client major < server major → exit 1 naming both versions |

## Business Rules
- **Consistency:** the row counts in the manifest and the dump come from the **same** database
  snapshot (exported snapshot shared with `pg_dump`), so a restore of a backup taken under live
  traffic still matches its manifest exactly. Storage is archived after the dump; files are
  immutable (unique keys), so the only possible skew is a file uploaded/removed during the backup —
  the backup prints `warning: <n> media_asset rows have no file in the archive` when it detects it
  (exit 0).
- **Throttle state is not backed up:** `rate_limit_bucket` schema is dumped, its rows are not
  (listed in `excludedData`, not in `tables`).
- The manifest is written last; a directory without `manifest.json` is not a backup (restore
  refuses it). Restore verifies `dumpSha256` / `archiveSha256` before touching the target.
- **Restore never overwrites silently:** a target database that has any table in schema `public`
  or a `drizzle` schema is "non-empty" → refused with `"<db> is not empty (<n> tables) — pass
  --force to replace it"`; a non-empty storage dir → refused likewise. `--force` drops and
  recreates schema `public` and drops schema `drizzle` (the migration ledger comes back from the
  dump), and empties the storage dir — but never a dir that is `/`, the home dir, the repo root,
  or contains `.git`.
- Restore runs `pg_restore --no-owner --no-acl --single-transaction --exit-on-error`, so the
  restored DB is either complete or unchanged; the restored DB's migration ledger equals the
  source's (`pnpm db:verify` on it shows the same applied count).
- After restoring, **restore-check** counts every manifest table in the target and every file
  (and total bytes) under the target storage dir; any difference is a failure (exit 1).
- Secrets: the database password is passed to the client tools via `PGPASSWORD`, never on the
  command line; no output line contains the URL's password.
- **Scope:** Postgres deployments only. A `pglite://` (designer mode) `BLOG0_DATABASE_URL` →
  exit 2 with "backups cover Postgres only — designer data lives in the PGlite directory; copy it
  while dev:design is stopped". Scheduling, off-site copies, encryption and retention are the
  operator's (cron suggestion in `docs/deploy.md`).
- Exit codes (both commands): 0 success, 1 failure, 2 usage error (unknown/missing flag, bad
  scheme).

> **Assumed:** the backup excludes `rate_limit_bucket` rows — throttle windows are ephemeral and
> restoring them would lock users out based on stale attempts.
> **Assumed:** backups run from a host with the repo checkout and PostgreSQL 18 client tools (the
> slim runtime image ships neither `pg_dump` nor the TypeScript scripts); the storage volume must be
> a host directory readable from there (bind mount) — the runbook says so.

## Success Criteria
- [ ] `pnpm backup -- --out var/backups` against `blog0_dev` exits 0, creates `var/backups/blog0-<stamp>/` with `db.dump`, `manifest.json` (and `storage.tar.gz` when `var/storage` has files), and the manifest's `tables` has one entry per table in `ALL_TABLE_NAMES` except `rate_limit_bucket`, each equal to `select count(*)` at backup time.
- [ ] `pnpm restore -- --in <that dir> --db blog0_restore_check --storage var/restore-check/storage` into a fresh DB prints `restore-check: OK (…)` and exits 0; `BLOG0_DATABASE_URL=postgres://sai@localhost:5432/blog0_restore_check pnpm db:verify` prints `0 pending: OK` with the same applied count as the source.
- [ ] Running the same restore again without `--force` exits 1 with `is not empty`; with `--force` it exits 0 and prints `restore-check: OK`.
- [ ] Integration test: rows inserted concurrently while a backup runs never make restore-check fail (manifest and dump come from one snapshot).
- [ ] Integration test: tampering one byte of `db.dump` → restore exits 1 with `checksum mismatch` before the target DB is created or changed.
- [ ] Integration test: deleting one file from the restored storage dir and re-running only the check (`restore … --check-only`) → `files … MISMATCH`, exit 1.
- [ ] With `PATH` lacking `pg_dump`, `pnpm backup -- --out var/backups` exits 1 and prints `pg_dump not found on PATH`; with `BLOG0_DATABASE_URL=pglite://./var/pglite` it exits 2.
- [ ] No stdout/stderr line of either command contains the DB password (integration test with a password-bearing URL captures output).
