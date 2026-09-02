# ---- Install and build ----
FROM oven/bun:1-slim AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

# ---- Run ----
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/server /app/server
COPY --from=build /src/migrations /app/migrations
COPY --from=build /src/web/dist /app/web-dist
ENV UTOPIA_WEB_DIST=/app/web-dist
EXPOSE 1516
CMD ["bun", "run", "server/src/index.ts"]
