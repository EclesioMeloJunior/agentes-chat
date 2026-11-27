# The `whatsapp` service of docker-compose.yml (ADR 0262): src/main.ts on Node, which runs TypeScript as it is.
# better-sqlite3 is built (or its prebuilt binary fetched) in the first stage; the second has no compiler.
FROM node:24-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json NOTICE ./
COPY src/http.ts src/inbox.ts src/sessions.ts src/main.ts ./src/
ENV NODE_ENV=production WHATSAPP_DATA=/data PORT=8080
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["node", "src/main.ts"]
