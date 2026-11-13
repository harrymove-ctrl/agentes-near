# agentes-near image: API, WebSocket, embedded PGlite, NEAR Intents & OutLayer TDX engine, and web app in one Bun process.
FROM oven/bun:1.4.4
WORKDIR /app

# Create writable PGlite database and file storage directories for the bun user.
RUN mkdir -p /data/pglite /data/files \
 && chown -R bun:bun /data

COPY . .

RUN bun install --frozen-lockfile \
 && mkdir -p apps/web/public/video \
 && bun -e "const fs = await import('node:fs'); for (const f of ['agentes-near-demo.mp4', 'agentes-near-x-teaser.mp4']) { const p = 'apps/web/public/video/' + f; if (!fs.existsSync(p)) { const r = await fetch('https://github.com/harrymove-ctrl/agentes-near/releases/download/v3.0.0/' + f); if (!r.ok) throw new Error('HTTP ' + r.status); await Bun.write(p, r); } }" \
 && bun run --filter '@agenteschat/web' build \
 && bun build apps/server/runner/main.ts --target=node --banner '#!/usr/bin/env node' --outfile apps/web/dist/runner/agentes-runner.mjs \
 && chmod +x /app/scripts/start-prod.sh \
 && chown -R bun:bun /app/apps/web/dist

ENV NODE_ENV=production \
    WEB_DIR=/app/apps/web/dist \
    DATABASE_URL=pglite:///data/pglite \
    FILES_DIR=/data/files \
    ZEN_DEMO_MODE=true \
    EMBEDDINGS_PROVIDER=none \
    TELEMETRY=off \
    PUSH_SENDER=off \
    WEB_PUSH=off \
    PORT=3000

USER bun
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/app/scripts/start-prod.sh"]
