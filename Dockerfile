FROM node:24-bookworm-slim AS verified
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY app.mjs settings.mjs tradingview.mjs notifications.mjs relay.mjs logging.mjs probe.mjs ./
COPY *.test.mjs ./
COPY public ./public
RUN npm run check && npm test

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3080
WORKDIR /app
COPY --from=verified /app/node_modules ./node_modules
COPY --from=verified /app/app.mjs /app/settings.mjs /app/tradingview.mjs /app/notifications.mjs /app/relay.mjs /app/logging.mjs ./
COPY --from=verified /app/public ./public
# Source archives may contain mode-600 files and mode-700 directories.
# Runtime code is root-owned but readable by the unprivileged app user.
RUN chmod -R a+rX /app
RUN mkdir /state && chown node:node /state && chmod 700 /state
USER node
# Relative .env and data/ paths live together on the persistent volume.
# Mount the directory, not .env itself: cookie saves use atomic rename.
WORKDIR /state
# Verify imports, static assets and writable persistent state as the runtime user.
RUN node --input-type=module -e "import { access, writeFile, rename, unlink, constants } from 'node:fs/promises'; await import('/app/app.mjs'); for (const file of ['index.html', 'client.js', 'style.css', 'logo.png', 'favicon.ico', 'apple-touch-icon.png']) await access('/app/public/' + file, constants.R_OK); await writeFile('.permission-check.tmp', 'ok', { mode: 0o600 }); await rename('.permission-check.tmp', '.permission-check'); await unlink('.permission-check');"
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:3080/api/status', { signal: AbortSignal.timeout(3000) }); if (!r.ok) process.exit(1);"
CMD ["node", "/app/app.mjs"]
