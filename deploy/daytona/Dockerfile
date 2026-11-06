# Pin the Node version; Playwright downloads its own matching Chromium revision from package-lock.
FROM node:24.13.1-bookworm-slim
ENV OUTREACH_HOME=/data/outreach \
    OUTREACH_DB=/data/outreach/outreach.db \
    OUTREACH_CHROME_PROFILE_DIR=/data/chrome-profiles \
    OUTREACH_CONFIG=/opt/outreach/outreach.config.mjs \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISPLAY=:99
WORKDIR /opt/outreach
COPY package.json package-lock.json tsconfig.base.json vitest.config.ts eslint.config.js ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY deploy/daytona ./deploy/daytona
RUN npm ci \
 && npm run build \
 && node -e "if(Number(process.versions.node.split('.')[0])!==24)process.exit(1)" \
 && npx --no-install playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fluxbox tini \
 && rm -rf /var/lib/apt/lists/* \
 && cp deploy/daytona/outreach.config.mjs /opt/outreach/outreach.config.mjs \
 && chmod +x deploy/daytona/entrypoint.sh \
 && mkdir -p /data/outreach /data/chrome-profiles /data/outreach/backups \
 && chmod 700 /data/outreach /data/chrome-profiles /data/outreach/backups
# These are sandbox-local durable disk directories, deliberately NOT Docker/Daytona FUSE VOLUMEs.
EXPOSE 8787 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/outreach/deploy/daytona/entrypoint.sh"]
