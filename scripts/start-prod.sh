#!/usr/bin/env sh
set -eu

mkdir -p /data/pglite /data/files

export PORT="${PORT:-3000}"
export DATABASE_URL="${DATABASE_URL:-pglite:///data/pglite}"
export FILES_DIR="${FILES_DIR:-/data/files}"
export WEB_DIR="${WEB_DIR:-/app/apps/web/dist}"
export ZEN_DEMO_MODE="${ZEN_DEMO_MODE:-true}"
export EMBEDDINGS_PROVIDER="${EMBEDDINGS_PROVIDER:-none}"
export TELEMETRY="${TELEMETRY:-off}"
export PUSH_SENDER="${PUSH_SENDER:-off}"
export WEB_PUSH="${WEB_PUSH:-off}"

if [ -z "${PUBLIC_URL:-}" ]; then
  if [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
    export PUBLIC_URL="https://${RAILWAY_PUBLIC_DOMAIN}"
  else
    export PUBLIC_URL="http://localhost:${PORT}"
  fi
fi

if [ -z "${AGENTES_SECRET:-}" ]; then
  if [ -f /data/.agentes_secret ]; then
    export AGENTES_SECRET="$(cat /data/.agentes_secret)"
  else
    export AGENTES_SECRET="agentes-near-hackathon-2026-demo-secret-32chars"
    printf '%s' "$AGENTES_SECRET" > /data/.agentes_secret 2>/dev/null || true
  fi
fi

if [ "$#" -gt 0 ]; then
  exec bun /app/apps/server/src/main.ts "$@"
fi

exec bun /app/apps/server/src/main.ts
