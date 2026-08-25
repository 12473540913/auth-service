# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# Full dependency set, used only to compile TypeScript.
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Resolved separately so devDependencies never reach the published image.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# node:22-alpine ships an unprivileged "node" user; running as root is not required here.
USER node

# Documentation only. Cloud Run injects PORT and the server binds to whatever it receives.
EXPOSE 8080

CMD ["node", "dist/server.js"]
