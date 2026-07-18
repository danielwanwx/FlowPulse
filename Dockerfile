FROM node:20-alpine

RUN apk add --no-cache sqlite
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY data ./data
COPY --chown=node:node package.json README.md LICENSE ./
RUN mkdir /data && chown node:node /data

USER node
ENV NODE_ENV=production \
    PORT=4310 \
    HOST=0.0.0.0 \
    FLOWPULSE_DB=/data/ledger.db \
    FLOWPULSE_DEVELOPMENT_ENABLED=0
EXPOSE 4310
VOLUME ["/data"]
CMD ["npm", "start"]
