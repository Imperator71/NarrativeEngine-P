FROM node:22-bookworm-slim
WORKDIR /app

# better-sqlite3 and onnxruntime-node compile/patch native bindings at install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# copy full engine package (includes tsconfig/src) before npm ci
COPY packages/engine ./packages/engine

# package.json pins allowScripts, so npm actually runs the install scripts for
# better-sqlite3 / esbuild / onnxruntime-node. Without them `npm ci` leaves the
# native modules unbuilt and the server cannot load sqlite-vec.
RUN npm ci

COPY . .

RUN npm run build --prefix packages/engine
# Frontend bundle. Express serves dist/ and the /api routes from the same port,
# so Caddy forwards one origin and there is no dev server in the image.
RUN npm run build

RUN mkdir -p /app/data /app/mods /app/public/assets/portraits

ENV HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 3001
VOLUME ["/app/data", "/app/mods", "/app/public/assets/portraits"]

CMD ["node", "server.js"]
