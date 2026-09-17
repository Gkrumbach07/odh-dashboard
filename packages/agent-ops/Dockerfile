# Build from the REPOSITORY ROOT, not from packages/agent-ops:
#
#     docker build -f packages/agent-ops/Dockerfile .
#
# agent-ops imports workspace packages (@odh-dashboard/plugin-core, ui-core,
# k8s-core, and @odh-dashboard/internal via frontend/src). None of those are
# declared in the module's package.json — they resolve through the npm workspace
# and webpack aliases — so a build context scoped to packages/agent-ops cannot
# see them and fails on the first cross-package import.
#
# This is the community variant: upstream base images, no FIPS. The image that
# actually ships is built from Dockerfile.workspace (see .tekton/), which uses
# the Red Hat base images and a CGO/strictfipsruntime build. The workspace
# package list below is deliberately kept in step with that file — if a build
# here fails on a missing @odh-dashboard/* package, compare the two lists first.

# Source code for the repos, relative to the repository root
ARG UI_SOURCE_CODE=./packages/agent-ops/frontend
ARG BFF_SOURCE_CODE=./packages/agent-ops/bff

# Set the base images for the build stages
ARG NODE_BASE_IMAGE=node:22
ARG GOLANG_BASE_IMAGE=golang:1.26
ARG DISTROLESS_BASE_IMAGE=gcr.io/distroless/static:nonroot

# UI build stage
FROM ${NODE_BASE_IMAGE} AS ui-builder

ARG UI_SOURCE_CODE
ARG DEPLOYMENT_MODE
ARG STYLE_THEME

WORKDIR /usr/src/workspace

### Workspace setup
# Root manifest first, so npm can compute the workspace graph
COPY package.json package-lock.json* ./
# The host frontend's manifest, so its dependencies resolve if referenced
COPY frontend/package.json ./frontend/
# Shared workspace packages this module builds against
COPY packages/plugin-core/ ./packages/plugin-core/
COPY packages/tsconfig/ ./packages/tsconfig/
COPY packages/foundation/ ./packages/foundation/
COPY packages/k8s-core/ ./packages/k8s-core/
COPY packages/ui-core/ ./packages/ui-core/
COPY packages/model-serving/ ./packages/model-serving/
COPY packages/model-registry/package.json ./packages/model-registry/
COPY packages/model-registry/shared/ ./packages/model-registry/shared/
COPY packages/hardware-profiles/ ./packages/hardware-profiles/
COPY packages/connection-types/ ./packages/connection-types/
# Host frontend source only — this is what @odh-dashboard/internal resolves to
COPY frontend/src/ ./frontend/src/

# The module itself
COPY ${UI_SOURCE_CODE} ./${UI_SOURCE_CODE}

# Install the dependencies and build
RUN npm cache clean --force
RUN npm ci --omit=optional --ignore-scripts

WORKDIR /usr/src/workspace/${UI_SOURCE_CODE}
RUN npm ci --omit=optional --ignore-scripts
RUN npm run build:prod

# BFF build stage
FROM ${GOLANG_BASE_IMAGE} AS bff-builder

ARG BFF_SOURCE_CODE

ARG TARGETOS
ARG TARGETARCH

WORKDIR /usr/src/app

# Copy the Go Modules manifests
COPY ${BFF_SOURCE_CODE}/go.mod ${BFF_SOURCE_CODE}/go.sum ./

# Download dependencies
RUN go mod download

# Copy the go source files
COPY ${BFF_SOURCE_CODE}/cmd/ cmd/
COPY ${BFF_SOURCE_CODE}/internal/ internal/
# pkg/ holds fleet, imported by internal/api. It is part of this module, so
# the build needs the directory itself — go mod download cannot supply it.
COPY ${BFF_SOURCE_CODE}/pkg/ pkg/
COPY packages/agent-ops/api/openapi/agent-ops.yaml openapi/src/agent-ops.yaml

# Build the Go application
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -a -o bff ./cmd

# Final stage
# Use distroless as minimal base image to package the application binary
FROM ${DISTROLESS_BASE_IMAGE}

ARG UI_SOURCE_CODE

WORKDIR /
COPY --from=bff-builder /usr/src/app/bff ./
COPY --from=bff-builder /usr/src/app/openapi/ ./openapi/
COPY --from=ui-builder /usr/src/workspace/packages/agent-ops/frontend/dist ./static/
USER 65532:65532

# Expose port 8080
EXPOSE 8080

ENTRYPOINT ["/bff"]
