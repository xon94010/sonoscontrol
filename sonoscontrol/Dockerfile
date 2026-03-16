FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY server.js ./
COPY public ./public

ENV SONOS_IP=192.168.1.64
EXPOSE 3000

CMD ["node", "server.js"]
