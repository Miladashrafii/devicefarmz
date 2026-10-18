FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    adb ffmpeg ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN npm install && npm run build \
    # video server jar for H.264 streaming (adb comes from apt)
    && node scripts/setup-tools.mjs scrcpy

ENV DEVICEFARMZ_PORT=7100
ENV DEVICEFARMZ_DATA=/data
EXPOSE 7100
CMD ["npm", "start"]
