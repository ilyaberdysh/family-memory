# Production image for Coolify: builds the React client and runs the Express agent server.
FROM node:24-bookworm-slim

WORKDIR /app

# Dependencies first for layer caching; tsx (devDependency) runs the server.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Headless Chromium for the archive-search adapters (OBD «Memorial» etc.).
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build

# The tree lives in DATA_DIR; mount a persistent volume there.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DATA_DIR=/data
VOLUME /data
EXPOSE 4317

CMD ["npm", "start"]
