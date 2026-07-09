# ---- Build stage: instala apenas dependencias de producao ----
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ---- Runtime stage: imagem final minima, utilizador nao-root ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

# Copia dependencias ja instaladas + codigo da aplicacao
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY prompt ./prompt
COPY knowledge ./knowledge

# Corre como utilizador nao-root (seguranca)
USER node

EXPOSE 8080

# Healthcheck: o orquestrador reinicia o container se /health falhar
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
