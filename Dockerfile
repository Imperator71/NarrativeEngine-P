FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/package-lock.json ./packages/engine/

RUN npm ci
RUN npm ci --prefix packages/engine

COPY . .
RUN npm run build --prefix packages/engine

RUN mkdir -p /app/data /app/mods /app/public/assets/portraits

ENV HOST=0.0.0.0
EXPOSE 5173 3001
VOLUME ["/app/data", "/app/mods", "/app/public/assets/portraits"]

CMD ["npm", "run", "dev"]
