# syntax=docker/dockerfile:1.7
#
# One image recipe for the three Node deployables (blueprint §5.3, D50, D58; GUARDRAILS Part 4).
#
#   docker build -f deploy/Dockerfile --build-arg SERVICE=risk-authorizer -t solmate-risk-authorizer .
#
# The build stage compiles the workspace and produces one self-contained bundle per service
# (apps/<service>/dist/main.js: no node_modules at runtime), then refuses to continue if that
# bundle contains a package the service's trust level bans or any bare require that is not a
# Node built-in (tools/check-artifacts.mjs). The runtime stage carries only the bundle and the
# contract-set lock, runs as the unprivileged `node` user and has no package manager, so a
# forbidden dependency cannot be added to a financial deployable after the fact.
#
# Node is pinned to the workspace version (ADR-0005, .nvmrc).

ARG NODE_IMAGE=node:24.20.0-alpine

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG SERVICE
RUN test -n "${SERVICE}" || { echo "build-arg SERVICE is required (worker | risk-authorizer | execution-service)"; exit 1; }
ENV CI=true \
    NX_DAEMON=false \
    NX_NO_CLOUD=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
RUN corepack enable

# Dependency layer: the lockfile alone drives the store, so source edits do not re-fetch.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline

RUN pnpm nx build @sol-agent-trader/${SERVICE} --configuration=production --skip-nx-cache --output-style=static \
 && node tools/check-artifacts.mjs --service ${SERVICE} \
 && test -s apps/${SERVICE}/dist/main.js

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
LABEL org.opencontainers.image.title="sol-agent-trader ${SERVICE}" \
      org.opencontainers.image.source="https://github.com/Brilliant-Innovations/solmate" \
      dev.solmate.service="${SERVICE}"
ENV NODE_ENV=production \
    SERVICE_NAME=${SERVICE}
WORKDIR /app
# No package manager in the runtime image: nothing can be installed into a financial deployable
# after the artifact scan ran. The base image ships npm, corepack and yarn; remove them.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /journal && chown node:node /journal /app
# The executor's durable journal mounts at /journal (EXECUTOR_JOURNAL_PATH=/journal); harmless elsewhere.
COPY --from=build --chown=node:node /src/apps/${SERVICE}/dist/main.js ./main.js
COPY --from=build --chown=node:node /src/libs/contracts/contract-set.lock.json ./contract-set.lock.json
USER node
ENTRYPOINT ["node"]
CMD ["main.js"]
