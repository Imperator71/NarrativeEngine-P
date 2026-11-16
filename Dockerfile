# syntax=docker/dockerfile:1.7
#
# Two stages on purpose.
#
#  builder      — dev dependencies, the TypeScript compiler and the frontend
#                  bundler. Nothing here reaches the runtime image except its
#                  build output.
#  runtime-deps — a production-only `npm ci` (better-sqlite3 and
#                  onnxruntime-node need python3/make/g++ while installing, so
#                  the toolchain lives here and nowhere else).
#  runtime      — node + production node_modules + the built server and bundle.
#
# Before this split every source edit invalidated one layer that held the whole
# node_modules tree (dev deps included), so a rebuild uploaded ~1.1 GB again and
# the pulled image was ~1.4 GB. Now an app-only change rebuilds just the dist
# and server layers.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Dependency manifests first: this layer only changes when dependencies do.
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/package.json
# package.json pins allowScripts, so npm actually runs the install scripts for
# better-sqlite3 / esbuild / onnxruntime-node. Without them `npm ci` leaves the
# native modules unbuilt and the server cannot load sqlite-vec.
RUN npm ci

COPY . .

RUN npm run build --prefix packages/engine
# Frontend bundle. Express serves dist/ and the /api routes from the same port,
# so Caddy forwards one origin and there is no dev server in the image.
RUN npm run build

FROM node:22-bookworm-slim AS runtime-deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/package.json
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

# Production dependencies only. `@narrative/engine` is a file: dependency, so
# node_modules carries a symlink to /app/packages/engine — that directory is
# provided below, and only its dist is needed at runtime.
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/server.js ./
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist

RUN mkdir -p /app/data /app/mods /app/public/assets/portraits

EXPOSE 3001
VOLUME ["/app/data", "/app/mods", "/app/public/assets/portraits"]

CMD ["node", "server.js"]
