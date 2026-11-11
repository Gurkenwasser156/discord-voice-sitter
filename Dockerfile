FROM node:24-slim

ENV NODE_ENV=production
# System-ffmpeg nutzen (ffmpeg-static wird im Image nicht installiert)
ENV FFMPEG_PATH=ffmpeg
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Optionale Pakete NICHT weglassen: @snazzah/davey (Voice-Verschlüsselung) liefert
# seine Linux-Binary als optionale Dependency. --ignore-scripts verhindert nur,
# dass ffmpeg-static sein eigenes ffmpeg herunterlädt (wir nutzen System-ffmpeg).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && node -e "require('@snazzah/davey')" \
 && npm cache clean --force

COPY index.js radio.js ./

USER node

CMD ["node", "index.js"]
