FROM node:22-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
RUN npm ci --omit=dev

COPY server.js ./server.js
COPY media-relay.js ./media-relay.js
COPY neural-relay.js ./neural-relay.js
COPY public ./public
COPY native ./native
COPY vendor ./vendor

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ready | grep -q '"ok":true' || exit 1

CMD ["node", "server.js"]
