# The API, for a host with a persistent disk (Render, Fly.io, Railway, a VPS).
#
# Not Vercel: this is a long-running process with a SQLite file, and a
# serverless function has neither. Mount a volume at /data and point
# DATABASE_FILE at it, or the ledger is lost on every deploy.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_FILE=/data/company.db
VOLUME ["/data"]
EXPOSE 3000

# JWT_SECRET, CORS_ORIGINS, COMPANY_NAME and the BOOTSTRAP_ADMIN_* pair come
# from the host's environment; the process refuses to start without the first.
CMD ["node", "dist/main.js"]
