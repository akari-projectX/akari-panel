# syntax=docker/dockerfile:1
#
# akari panel image (M1-1). Multi-stage:
#   spa        builds the React bundle (embedded into the binary)
#   builder    static musl binary (rust:alpine; no system C library
#              dependency — the vendored OpenSSL of the passkey verifier is
#              compiled in — so the result runs on any Linux kernel)
#   artifact   FROM scratch holding only the binary: the release workflow
#              exports it (`--target artifact --output type=local,dest=out`)
#              so the tarball and the image carry the same bytes
#   prebuilt   runtime image from an already built binary (release workflow)
#   runtime    (default) runtime image built from source
#
# Runtime: distroless static, UID 65532 (nonroot), no shell, no package
# manager. There is no HEALTHCHECK (nothing to run it with): probe
# GET /<route prefix>/healthz from outside (see docs/DEPLOY.md).
#
#   docker build -t akari-panel --build-arg AKARI_GIT_SHA=$(git rev-parse --short=12 HEAD) .
#
# Reproducibility: pinned toolchain tag, `--locked`, fixed path prefix and
# remapped build paths, SOURCE_DATE_EPOCH from the commit (build arg).

ARG NODE_IMAGE=node:24-alpine
ARG RUST_IMAGE=rust:1.99-alpine
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot

FROM ${NODE_IMAGE} AS spa
WORKDIR /src/spa
COPY spa/package.json spa/package-lock.json ./
RUN npm ci
COPY spa/ ./
RUN npm run build

FROM ${RUST_IMAGE} AS builder
RUN apk add --no-cache musl-dev gcc make cmake perl linux-headers
WORKDIR /src
ARG AKARI_GIT_SHA=unknown
ARG SOURCE_DATE_EPOCH=0
ENV AKARI_GIT_SHA=${AKARI_GIT_SHA} \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    CARGO_PROFILE_RELEASE_LTO=thin \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    CARGO_PROFILE_RELEASE_STRIP=true \
    RUSTFLAGS="--remap-path-prefix=/src=/akari --remap-path-prefix=/usr/local/cargo=/cargo"
COPY Cargo.toml Cargo.lock build.rs ./
COPY proto proto
COPY migrations migrations
COPY src src
COPY deploy/systemd deploy/systemd
COPY --from=spa /src/spa/dist spa/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
 && cp target/release/akari /akari

# Empty data dir owned by the runtime user (distroless has no shell to mkdir
# with); a named volume mounted on /data inherits this ownership.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS datadir
RUN mkdir -m 0750 /data

FROM scratch AS artifact
COPY --from=builder /akari /akari

FROM ${RUNTIME_IMAGE} AS prebuilt
ARG TARGETARCH
COPY --chown=65532:65532 --chmod=0555 dist/akari-linux-${TARGETARCH} /akari
COPY --from=datadir --chown=65532:65532 /data /data
VOLUME /data
WORKDIR /
EXPOSE 8080 8443
ENTRYPOINT ["/akari"]
CMD ["serve"]

FROM ${RUNTIME_IMAGE} AS runtime
COPY --from=builder --chown=65532:65532 --chmod=0555 /akari /akari
COPY --from=datadir --chown=65532:65532 /data /data
VOLUME /data
# data_dir defaults to ./data, i.e. /data
WORKDIR /
EXPOSE 8080 8443
ENTRYPOINT ["/akari"]
CMD ["serve"]
