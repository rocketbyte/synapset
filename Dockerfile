# syntax=docker/dockerfile:1
# Builds one service: docker build --build-arg APP=api|worker .
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build
ARG APP
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/${APP} apps/${APP}
RUN pnpm exec tsc -b apps/${APP} \
 && pnpm --filter @synapset/${APP} deploy --prod /out

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/main.js"]
