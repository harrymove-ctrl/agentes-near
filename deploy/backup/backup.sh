#!/bin/sh
# The `backup` service of docker-compose.yml: every day at 03:00 UTC (or every BACKUP_INTERVAL_HOURS
# hours from then), a pg_dump of the database to an S3-compatible bucket, deleting dumps older than
# BACKUP_RETENTION_DAYS (14 by default). Settings and the restore:
# https://agentes.chat/docs/install-on-a-server#backups
#   backup.sh             the schedule (what the service runs)
#   backup.sh now         one dump, right away
#   backup.sh list        the dumps in the bucket
#   backup.sh fetch NAME  one dump, to stdout
set -eu

if [ -z "${S3_BACKUP_BUCKET:-}" ]; then
  echo "backup: off, S3_BACKUP_BUCKET is not set (https://agentes.chat/docs/install-on-a-server#backups)" >&2
  # The service idles instead of exiting, which restart: unless-stopped would turn into a loop.
  [ "$#" -gt 0 ] || exec sleep infinity
  exit 1
fi

# rclone set up from the environment alone: no config file, and no secret on a command line.
export RCLONE_CONFIG=/dev/null
export RCLONE_S3_PROVIDER="${S3_PROVIDER:-Cloudflare}"
export RCLONE_S3_ENDPOINT="${S3_ENDPOINT:-}"
export RCLONE_S3_REGION="${S3_REGION:-auto}"
export RCLONE_S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-}"
export RCLONE_S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-}"
# A key limited to one bucket can't list or create buckets.
export RCLONE_S3_NO_CHECK_BUCKET=true
bucket=":s3:${S3_BACKUP_BUCKET}"

# This service's dumps only, at the top of the bucket: anything else there is left alone.
dumps() { rclone "$@" --max-depth 1 --include 'agentes-*.dump' "$bucket"; }

case "${1:-}" in
  now)
    name="agentes-$(date -u +%Y%m%d-%H%M%S).dump"
    echo "backup: dumping the database to ${name}"
    pg_dump --format=custom --file=/tmp/agentes.dump "$DATABASE_URL"
    # rclone fails unless the uploaded object's size and checksum match the file.
    rclone copyto /tmp/agentes.dump "${bucket}/${name}"
    rm /tmp/agentes.dump
    dumps delete --min-age "${BACKUP_RETENTION_DAYS:-14}d"
    echo "backup: ${name} uploaded"
    ;;
  list)
    dumps lsl
    ;;
  fetch)
    exec rclone cat "${bucket}/${2:?usage: backup.sh fetch NAME}"
    ;;
  "")
    hours=${BACKUP_INTERVAL_HOURS:-24}
    case $hours in
      *[!0-9]* | 0*)
        echo "backup: BACKUP_INTERVAL_HOURS=${hours} is not a whole number of hours, so one dump a day" >&2
        hours=24
        ;;
    esac
    # A dump at start, unless the last one is younger than the interval plus 2 hours: each restart or
    # upgrade would take another, and a migration waits for a dump to finish. A listing that fails
    # counts as none.
    if [ -z "$(dumps lsf --files-only --max-age "$((hours + 2))h" || true)" ]; then
      "$0" now || echo "backup: failed, next try at the next scheduled dump" >&2
    fi
    period=$((hours * 3600))
    while :; do
      now=$(date -u +%s)
      # At 03:00 UTC and every period from then. In the background, so a stop signal ends the wait at
      # once instead of after the sleep.
      sleep $((period - (now - 10800) % period)) &
      wait $!
      "$0" now || echo "backup: failed, next try at the next scheduled dump" >&2
    done
    ;;
  *)
    echo "usage: backup.sh [now | list | fetch NAME]" >&2
    exit 2
    ;;
esac
