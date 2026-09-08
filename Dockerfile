FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY shared ./shared
COPY server ./server
COPY src ./src
COPY public ./public
COPY tests ./tests
RUN npm run build

FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libheif-examples ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/family-space && chown node:node /var/lib/family-space
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DATA_DIR=/var/lib/family-space/data
COPY LICENSE ./LICENSE
COPY --from=build /app/package.json /app/package-lock.json ./
# npm start uses tsx; retain dependencies installed by the existing package scripts.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY scripts/backup.mjs scripts/restore.mjs ./scripts/
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/auth/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
