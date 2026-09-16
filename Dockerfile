FROM docker.io/library/node:24.5.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
FROM docker.io/library/node:24.5.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production REPLAY_HOST=0.0.0.0 PORT=5181 REPLAY_DATA_DIR=/data
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5181
CMD ["node","--import","tsx","src/server/index.ts"]
