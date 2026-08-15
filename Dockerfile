FROM node:22.16.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY design-system ./design-system
RUN pnpm install --frozen-lockfile

COPY database ./database
COPY scripts ./scripts
COPY src ./src
RUN pnpm build \
  && pnpm --filter @answer-engine/web-ui build \
  && pnpm --filter @answer-engine/mcp-server build \
  && pnpm exec tsc \
    --target ES2022 \
    --module NodeNext \
    --moduleResolution NodeNext \
    --esModuleInterop \
    --strict \
    --skipLibCheck \
    --outDir dist/scripts \
    scripts/database.ts scripts/migration-utils.ts scripts/migrate.ts scripts/rollback.ts scripts/init.ts scripts/boot-check-local.ts

FROM node:22.16.0-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Answer Engine"
LABEL org.opencontainers.image.version="1.1.0"
LABEL org.opencontainers.image.licenses="Apache-2.0"

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production

RUN corepack enable \
  && corepack prepare pnpm@10.33.0 --activate \
  && apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
COPY --from=build /app/database ./database
COPY --from=build /app/packages/web-ui/dist ./web-ui
COPY --from=build /app/packages/mcp-server/dist ./packages/mcp-server/dist

ENV WEB_UI_DIR=/app/web-ui

RUN groupadd --system --gid 10001 answerengine \
  && useradd --system --uid 10001 --gid answerengine --home-dir /data answerengine \
  && mkdir -p /data/blobs /data/raw-archive \
  && chown -R answerengine:answerengine /data

USER answerengine
EXPOSE 5000

CMD ["node", "dist/server.js"]
