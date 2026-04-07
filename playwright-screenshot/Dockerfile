FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install && npx playwright install chromium

COPY tsconfig.json server.ts ./
RUN npx tsc && npm prune --omit=dev

EXPOSE 3000

CMD ["node", "dist/server.js"]
