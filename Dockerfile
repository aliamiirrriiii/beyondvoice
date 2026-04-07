FROM node:22-alpine AS build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

RUN apk add --no-cache bash build-base cmake linux-headers

COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
RUN npm ci --omit=dev

COPY server.js ./server.js
COPY media-relay.js ./media-relay.js
COPY neural-relay.js ./neural-relay.js
COPY public ./public
COPY native ./native
COPY vendor ./vendor
COPY scripts ./scripts

RUN ./scripts/build-neural-relay.sh --mode native-opus

FROM node:22-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

RUN apk add --no-cache libstdc++

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/media-relay.js ./media-relay.js
COPY --from=build /app/neural-relay.js ./neural-relay.js
COPY --from=build /app/public ./public
COPY --from=build /app/native ./native

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ready | grep -q '"ok":true' || exit 1

CMD ["node", "server.js"]
