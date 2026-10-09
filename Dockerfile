FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --include=dev && npm run build && npm prune --omit=dev

# auth_info/ doit survivre aux redeploiements : montez un volume persistant
# sur /app/auth_info (contient dashboard_data.json : conversations, modeles,
# prospects, journal — plus de cles de session WhatsApp depuis le passage
# a l'API officielle Meta, mais on garde le meme volume pour ne rien perdre).
VOLUME ["/app/auth_info"]

ENV PORT=3300
EXPOSE 3300

CMD ["node", "dist/index.js"]
