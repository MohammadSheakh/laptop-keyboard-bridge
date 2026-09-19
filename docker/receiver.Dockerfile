FROM node:22-bookworm-slim AS helper-build

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY native/linux-uinput-helper.c ./linux-uinput-helper.c
RUN gcc -O2 -Wall -Wextra -Werror -o /out-keybridge-uinput-helper linux-uinput-helper.c

FROM node:22-bookworm-slim

WORKDIR /app
COPY docker/receiver-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY src/core.js ./src/core.js
COPY src/linux-keymap.js ./src/linux-keymap.js
COPY src/docker-receiver.js ./src/docker-receiver.js
COPY --from=helper-build /out-keybridge-uinput-helper /usr/local/bin/keybridge-uinput-helper

ENV NODE_ENV=production \
    KEYBRIDGE_PORT=39393 \
    KEYBRIDGE_BIND=0.0.0.0

EXPOSE 39393
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const net=require('net');const p=Number(process.env.KEYBRIDGE_PORT||39393);const s=net.connect({host:'127.0.0.1',port:p},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)"

CMD ["node", "src/docker-receiver.js"]
