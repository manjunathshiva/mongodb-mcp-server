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
# the native deps it lists are not compiled) and build the ESM+CJS workspace
# output. Then `pnpm deploy` produces a SELF-CONTAINED /deploy directory with
# only the package's published files (dist/) and production dependencies —
# workspace deps (@mongodb-js/mcp-metrics, mcp-types) are injected as real
# copies, not symlinks. This is what actually shrinks the image: an in-place
# `pnpm install --prod` does not reclaim space because pnpm's content-
# addressable .pnpm store retains every previously-installed (dev) package.
RUN corepack prepare pnpm@10.33.2 --activate \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm run build \
    && pnpm --filter=mongodb-mcp-server deploy --prod --legacy /deploy

# ---- runtime ---------------------------------------------------------------
FROM node:24-alpine AS runtime

# Non-root runtime user.
RUN addgroup -S mcp && adduser -S mcp -G mcp

WORKDIR /home/mcp/app

# Copy only the self-contained production deploy (dist/ + prod node_modules).
# No source, tests, scripts, or dev dependencies.
COPY --from=builder --chown=mcp:mcp /deploy ./

USER mcp

ENV NODE_ENV=production \
    MDB_MCP_LOGGERS=stderr,mcp

# The MCP server binary entry point (CJS+ESM dual build; ESM entry used here).
ENTRYPOINT ["node", "dist/esm/index.js"]

LABEL description="MongoDB MCP Server (hardened branch, source build)"
LABEL io.modelcontextprotocol.server.name="io.github.mongodb-js/mongodb-mcp-server"
