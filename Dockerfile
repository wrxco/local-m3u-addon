FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7000
ENV PLAYLIST_PATH=/data/playlist.m3u8
ENV ADDON_NAME="Local M3U Add-on"

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY bin ./bin
COPY playlists/example.m3u8 ./playlists/example.m3u8

EXPOSE 7000

CMD ["node", "src/server.js"]
