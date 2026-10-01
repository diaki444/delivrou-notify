FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --include=dev && npm run build && npm prune --omit=dev

# auth_info/ doit survivre aux redeploiements : montez un volume persistant
# sur /app/auth_info (sinon il faudra rescanner un QR a chaque deploiement).
VOLUME ["/app/auth_info"]

ENV PORT=3300
EXPOSE 3300

CMD ["node", "dist/index.js"]
