# ChatGPT Gateway: the OpenAI-compatible API over the owner's ChatGPT plan.
#
#   docker build -t chatgpt-gateway .
#   docker run -d -p 8780:8780 -v chatgpt-gateway-data:/data chatgpt-gateway
#
# Node runs the TypeScript sources directly (type stripping), so there is no build step. The first
# start creates /data/api_key. The same image runs as the Home Assistant app (addon/).

# --- dependencies: production only, pinned by the lockfile ---------------------------------------
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p node_modules

# --- runtime -----------------------------------------------------------------------------------
FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
VOLUME /data
EXPOSE 8780
ENTRYPOINT ["node", "src/main.ts"]
