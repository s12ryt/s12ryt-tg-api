FROM mirror.gcr.io/library/node:24-bookworm-slim AS build

WORKDIR /app/nodejs

ENV NODE_ENV=development

COPY nodejs/package*.json nodejs/.npmrc ./
RUN npm ci --engine-strict

COPY nodejs/ ./
RUN npm run build

FROM mirror.gcr.io/library/node:24-bookworm-slim AS runtime

WORKDIR /app/nodejs

ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    API_PORT=8000

COPY nodejs/package*.json nodejs/.npmrc ./
RUN npm ci --omit=dev --engine-strict && npm cache clean --force

COPY --from=build /app/nodejs/dist ./dist
COPY nodejs/scripts ./scripts
COPY nodejs/web ./web
COPY nodejs/start.js ./start.js
COPY VERSION ./VERSION

RUN mkdir -p data && chown -R node:node /app

USER node
EXPOSE 8000
CMD ["npm", "start"]
