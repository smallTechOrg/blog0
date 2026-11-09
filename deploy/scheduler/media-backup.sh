#!/usr/bin/env bash
# Daily media backup (Stage B, spec/architecture.md §12.7) — run by supercronic in the `scheduler`
# image: mirrors the uploads volume (/data/storage, mounted read-only) to MEDIA_BACKUP_DEST with
# rclone, no config file:
#   prod  MEDIA_BACKUP_DEST=:gcs,env_auth=true,bucket_policy_only=true:<bucket>/media
#         (auth = the VM's attached service account via the metadata server; the bucket keeps
#         noncurrent object versions for 30 days, so a deleted/overwritten upload stays recoverable)
#   local MEDIA_BACKUP_DEST=/backup/media
# Prints one JSON line {"event":"ops.media_backup","outcome":"ok"|"failed",…}; then pings
# BLOG0_HEARTBEAT_BACKUP_URL (success) or <url>/fail with curl -fsS -m 5 (a ping failure never changes
# the exit code; unset → no ping; the URL is never printed). Exit 0 ok, 1 failure, 2 misconfiguration.
set -euo pipefail

SRC="${MEDIA_BACKUP_SRC:-/data/storage}"
DEST="${MEDIA_BACKUP_DEST:-}"
HEARTBEAT="${BLOG0_HEARTBEAT_BACKUP_URL:-}"

now_ms() { date +%s%3N; }
log_line() { # <outcome> <durationMs> [detail]
  local detail="${3:-}"
  detail="${detail//\\/\\\\}"
  detail="${detail//\"/\\\"}"
  printf '{"ts":"%s","level":"%s","event":"ops.media_backup","outcome":"%s","durationMs":%s%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$([[ "$1" == ok ]] && echo info || echo error)" "$1" "$2" \
    "${detail:+,\"detail\":\"${detail}\"}"
}
ping_heartbeat() { # success|fail
  [[ -n "$HEARTBEAT" ]] || return 0
  case "$HEARTBEAT" in http://* | https://*) ;; *)
    echo '{"event":"ops.heartbeat","job":"media_backup","outcome":"invalid_url"}'
    return 0
    ;;
  esac
  local url="${HEARTBEAT%/}"
  [[ "$1" == fail ]] && url="${url}/fail"
  curl -fsS -m 5 -o /dev/null "$url" >/dev/null 2>&1 || echo "{\"event\":\"ops.heartbeat\",\"job\":\"media_backup\",\"outcome\":\"error\"}"
}

if [[ -z "$DEST" ]]; then
  log_line failed 0 "MEDIA_BACKUP_DEST is not set"
  ping_heartbeat fail
  exit 2
fi
if [[ ! -d "$SRC" ]]; then
  log_line failed 0 "source ${SRC} is not a directory"
  ping_heartbeat fail
  exit 2
fi

t0="$(now_ms)"
set +e
# --config /dev/null: no rclone.conf; the remote is fully described by MEDIA_BACKUP_DEST.
out="$(rclone sync "$SRC" "$DEST" --config /dev/null --checksum --fast-list --stats-one-line --stats 0 2>&1)"
status=$?
set -e
duration=$(($(now_ms) - t0))
if [[ "$status" -eq 0 ]]; then
  # A tiny status object next to the mirror (outside `media/`, so the sync never deletes it): proves the
  # write path to the destination even while there are no uploads yet, and shows when the last run was.
  STATUS_DEST="${MEDIA_BACKUP_STATUS_DEST:-${DEST%/*}/_status}"
  printf 'last media backup (UTC): %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" |
    rclone rcat "${STATUS_DEST}/last-media-backup.txt" --config /dev/null >/dev/null 2>&1 ||
    echo '{"event":"ops.media_backup","outcome":"status_marker_failed"}'
  log_line ok "$duration"
  ping_heartbeat success
  exit 0
fi
# rclone's own error text (never contains a credential: auth comes from the metadata server).
log_line failed "$duration" "rclone exit ${status}: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ' | cut -c1-300)"
ping_heartbeat fail
exit 1
