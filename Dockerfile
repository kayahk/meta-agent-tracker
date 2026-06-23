# Multi-stage Dockerfile for meta-agent
# Produces a single image supporting both API and worker entry points.

# ─── Build stage ───────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /src

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests and shared TypeScript config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json tsconfig.base.json ./

# Install dependencies (frozen lockfile)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY apps/ apps/

# Build all packages
RUN pnpm build

# ─── Runtime stage ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# node:alpine already provides a non-root `node` user/group with uid/gid 1000.
# Reuse it instead of creating our own uid 1000 account, because recent base
# images fail with `addgroup: gid '1000' in use`.
WORKDIR /app

# Create writable directories
RUN mkdir -p /data && chown node:node /data

# Copy built artifacts (only dist/ from each package/app)
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/packages/config/dist ./packages/config/dist
COPY --from=build --chown=node:node /src/packages/config/package.json ./packages/config/package.json
COPY --from=build --chown=node:node /src/packages/storage/dist ./packages/storage/dist
COPY --from=build --chown=node:node /src/packages/storage/package.json ./packages/storage/package.json
COPY --from=build --chown=node:node /src/packages/hermes/dist ./packages/hermes/dist
COPY --from=build --chown=node:node /src/packages/hermes/package.json ./packages/hermes/package.json
COPY --from=build --chown=node:node /src/packages/llm-client/dist ./packages/llm-client/dist
COPY --from=build --chown=node:node /src/packages/llm-client/package.json ./packages/llm-client/package.json
COPY --from=build --chown=node:node /src/packages/github/dist ./packages/github/dist
COPY --from=build --chown=node:node /src/packages/github/package.json ./packages/github/package.json
COPY --from=build --chown=node:node /src/packages/github-adapter/dist ./packages/github-adapter/dist
COPY --from=build --chown=node:node /src/packages/github-adapter/package.json ./packages/github-adapter/package.json
COPY --from=build --chown=node:node /src/packages/plan-parser/dist ./packages/plan-parser/dist
COPY --from=build --chown=node:node /src/packages/plan-parser/package.json ./packages/plan-parser/package.json
COPY --from=build --chown=node:node /src/packages/jira-adapter/dist ./packages/jira-adapter/dist
COPY --from=build --chown=node:node /src/packages/jira-adapter/package.json ./packages/jira-adapter/package.json
COPY --from=build --chown=node:node /src/packages/work-catalog/dist ./packages/work-catalog/dist
COPY --from=build --chown=node:node /src/packages/work-catalog/package.json ./packages/work-catalog/package.json
COPY --from=build --chown=node:node /src/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /src/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /src/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /src/apps/worker/package.json ./apps/worker/package.json
# Copy shared deps
COPY --from=build --chown=node:node /src/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /src/apps/worker/node_modules ./apps/worker/node_modules

USER node

# Default: API server
EXPOSE 4317
ENV META_AGENT_API_HOST=0.0.0.0
ENV META_AGENT_API_PORT=4317

ENTRYPOINT ["node"]
CMD ["apps/api/dist/index.js"]
