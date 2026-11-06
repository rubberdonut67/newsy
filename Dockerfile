FROM node:24-slim

# HOST: the app defaults to loopback, which a container cannot be reached on.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app

# Dependencies first so source edits do not invalidate the install layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node 24 runs TypeScript directly, so there is no build step to keep in sync.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
