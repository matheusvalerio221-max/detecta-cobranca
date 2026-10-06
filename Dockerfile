FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3100
COPY package.json ./
COPY src ./src
VOLUME ["/data"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3100/cobranca/saude >/dev/null || exit 1
CMD ["node", "--no-warnings", "src/server.js"]
