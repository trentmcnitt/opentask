# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app

# Native modules (better-sqlite3, bcrypt) need build tools
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: Build the application
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# dump-prompts.ts imports from tests/ which is excluded from the Docker
# context. It's a dev tool, not needed for the production build.
RUN rm -f scripts/dump-prompts.ts

# Generate build ID and build Next.js standalone output
RUN NEXT_PUBLIC_BUILD_ID=$(node -e "const d=new Date();console.log(d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0')+'-'+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0'))") \
    npx next build

# Stage 3: Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

LABEL org.opencontainers.image.source="https://github.com/trentmcnitt/opentask"
LABEL org.opencontainers.image.description="Self-hosted task manager - Next.js + SQLite"
LABEL org.opencontainers.image.licenses="AGPL-3.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# tsx for management scripts, sqlite for backup commands
RUN apk add --no-cache sqlite && \
    npm install -g tsx@4

# Copy the standalone Next.js server (includes production node_modules)
COPY --from=builder /app/.next/standalone ./
# Copy static assets and public files
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy source and scripts needed for management commands.
# Scripts import from src/core/ and need tsconfig for path resolution.
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json

# Entrypoint handles optional auto-setup via env vars
COPY --chmod=755 docker-entrypoint.sh ./

# Create data directory for SQLite
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

USER nextjs

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
