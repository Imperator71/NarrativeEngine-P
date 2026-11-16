# syntax=docker/dockerfile:1.7
#
# Two stages on purpose.
#
#  builder — dev dependencies, the TypeScript compiler, the frontend bundler.
#            Builds the engine package and the frontend bundle, then PRUNES the
#            dev dependencies: `tsc` must exist while building the `file:`
#            engine dependency (its `prepare` script runs `npm run build`), so
#            a separate `npm ci --omit=dev` stage would fail with `tsc: not
#            found`.
#  runtime — node, the pruned production node_modules, and the build output.
#            No compiler, no bundler, no toolchain.
#
# Before this split every source edit invalidated one layer holding the whole
# node_modules tree (dev deps included) and a rebuild re-uploaded ~1.1 GB; with
# no .dockerignore the host's node_modules rode along too. The pulled image was
# ~1.4 GB.

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

# Production dependencies only. Runs after the builds, so the toolchain the
# engine's `prepare` script needs is still present; nothing here re-compiles.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

# `@narrative/engine` is a file: dependency, so node_modules carries a symlink to
# /app/packages/engine — that directory is provided below with its built dist.
COPY --from=builder /app/node_modules ./node_modules
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
