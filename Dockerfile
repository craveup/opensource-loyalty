FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY examples ./examples
COPY spec ./spec
RUN npm ci \
  && npm run build \
  && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine AS runtime

WORKDIR /app
ENV HOST=0.0.0.0
ENV PORT=3210
ENV LIP_DATABASE_PATH=/data/reference.db

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/cloud ./apps/cloud
COPY --from=build /app/apps/wallet ./apps/wallet
COPY --from=build /app/packages ./packages
RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 3210 3220 3230

HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${HEALTH_PORT:-3210}/health" >/dev/null || exit 1

CMD ["node", "packages/server/dist/cli.js"]
