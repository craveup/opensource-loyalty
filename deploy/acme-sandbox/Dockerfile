# Public Sandbox cutover target for Acme Asian Grill.
# Render builds this from the opensource-loyalty checkout (public repo).
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build

WORKDIR /app
COPY . .
RUN npm ci \
  && npm run build \
  && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime

WORKDIR /app
ENV HOST=0.0.0.0
ENV PORT=3210
ENV LIP_DATABASE_PATH=/data/reference.db

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY deploy/acme-sandbox/acme-program.json /config/acme-program.json
COPY deploy/acme-sandbox/start-loyalty.sh /usr/local/bin/start-loyalty

RUN mkdir -p /data \
  && chmod +x /usr/local/bin/start-loyalty \
  && chown -R node:node /app /data /config

USER node
EXPOSE 3210

# Render injects PORT (10000 for web services); the fallback matches local runs.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3210}/health" >/dev/null || exit 1

CMD ["/usr/local/bin/start-loyalty"]
