FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# copy full engine package (includes tsconfig/src) before npm ci
COPY packages/engine ./packages/engine

RUN npm ci

COPY . .
RUN npm run build --prefix packages/engine

RUN mkdir -p /app/data /app/mods /app/public/assets/portraits

ENV HOST=0.0.0.0
EXPOSE 5173 3001
VOLUME ["/app/data", "/app/mods", "/app/public/assets/portraits"]

CMD ["npm", "run", "dev"]
