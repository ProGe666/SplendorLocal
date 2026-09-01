FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js ./
COPY game ./game
COPY data ./data
COPY public ./public
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
