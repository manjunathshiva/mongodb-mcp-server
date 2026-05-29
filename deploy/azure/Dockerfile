# Source-build image for the hardened MongoDB MCP Server branch.
#
# Unlike the repo-root Dockerfile (which `npm install -g`s the PUBLISHED
# package), this builds THIS checkout from source so the image contains the
# hardened branch (X.509-only auth, no delete tools, OAuth/MCP07, etc.).
#
# Build from the repo root so the build context includes src/, scripts/,
# packages/ and the lockfile:
#
#   docker build -f deploy/azure/Dockerfile -t <acr>.azurecr.io/mongodb-mcp-server:hardened .
#
# Runtime configuration (transport, host, port, auth, connection string,
# cert) is supplied by the environment — see deploy/azure/bicep. This image
# bakes only logging defaults so it stays deployment-agnostic.

# ---- builder ---------------------------------------------------------------
FROM node:24-alpine AS builder

# HUSKY=0 disables git hooks (no .git / not wanted in CI). CI=true keeps tool
# output non-interactive.
ENV HUSKY=0 CI=true
WORKDIR /src

# Pin pnpm to the version the repo declares in package.json "packageManager".
RUN corepack enable

# Copy the whole context (scoped by deploy/azure/Dockerfile.dockerignore) so
# the pnpm workspace (root + packages/* + tests/browser) resolves against the
# frozen lockfile.
COPY . .

# Install dev+prod deps (scripts ignored — matches the repo's normal posture,
# the native deps it lists are not compiled), build the ESM+CJS workspace
# output, then prune to production dependencies in place. Build runs before
# the prune so devDeps (tsc, tsx, vite, ...) are available during compile.
RUN corepack prepare pnpm@10.33.2 --activate \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm run build \
    && pnpm install --prod --frozen-lockfile --ignore-scripts

# ---- runtime ---------------------------------------------------------------
FROM node:24-alpine AS runtime

# Non-root runtime user.
RUN addgroup -S mcp && adduser -S mcp -G mcp

WORKDIR /home/mcp/app

# Copy the built tree with production-only node_modules. The pnpm workspace
# packages (@mongodb-js/mcp-metrics, @mongodb-js/mcp-types) are symlinked from
# node_modules into packages/*/dist, so the whole tree is copied to keep those
# links valid. tests/browser and other dev workspace members were pruned by
# the production install above.
COPY --from=builder --chown=mcp:mcp /src ./

USER mcp

ENV NODE_ENV=production \
    MDB_MCP_LOGGERS=stderr,mcp

# The MCP server binary entry point (CJS+ESM dual build; ESM entry used here).
ENTRYPOINT ["node", "dist/esm/index.js"]

LABEL description="MongoDB MCP Server (hardened branch, source build)"
LABEL io.modelcontextprotocol.server.name="io.github.mongodb-js/mongodb-mcp-server"
