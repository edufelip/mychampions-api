FROM oven/bun:1.3.14

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
COPY infra/railway/start.sh ./infra/railway/start.sh

EXPOSE 3400

CMD ["sh", "/app/infra/railway/start.sh"]
