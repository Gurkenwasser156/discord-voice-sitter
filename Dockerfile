FROM node:24-slim

ENV NODE_ENV=production
# System-ffmpeg nutzen (ffmpeg-static wird im Image nicht installiert)
ENV FFMPEG_PATH=ffmpeg
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force

COPY index.js radio.js ./

USER node

CMD ["node", "index.js"]
