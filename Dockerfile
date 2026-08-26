FROM node:22.23.2-alpine3.24 AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22.23.2-alpine3.24 AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S belki && adduser -S -G belki belki
COPY --from=build --chown=belki:belki /app/dist ./dist
COPY --from=build --chown=belki:belki /app/migrations/postgres ./migrations/postgres
COPY --from=build --chown=belki:belki /app/node_modules ./node_modules
COPY --from=build --chown=belki:belki /app/package.json ./package.json
USER belki
EXPOSE 3000
CMD ["node", "dist/server/server.js"]
