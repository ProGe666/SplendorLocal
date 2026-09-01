FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
COPY game ./game
COPY data ./data
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
