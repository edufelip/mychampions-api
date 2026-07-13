FROM oven/bun:1.3.10

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

EXPOSE 3400

CMD ["bun", "run", "start"]
