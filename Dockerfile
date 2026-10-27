# syntax=docker/dockerfile:1
#
# akari panel image (M1-1). Multi-stage:
#   portal     builds the user portal (Svelte; embedded into the binary)
#   admin      builds the admin app (embedded into the binary)
#   chef       rust:alpine + build tools + cargo-chef (pinned)
#   planner    `cargo chef prepare`: the dependency recipe (manifests and
#              lockfile only; the crate's own version is masked, so CI's
#              version bump does not invalidate it)
#   deps       `cargo chef cook`: the dependencies compiled in their own
#              layer (CI keeps this stage in its BuildKit `type=gha` cache:
#              unchanged deps are not rebuilt)
#   builder    the static musl binary (rust:alpine; no system C library
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
# GET /healthz from outside (see docs/DEPLOY.md).
#
#   docker build -t akari-panel --build-arg AKARI_GIT_SHA=$(git rev-parse --short=12 HEAD) .
#
# Reproducibility: pinned toolchain tag, `--locked`, fixed path prefix and
# remapped build paths, SOURCE_DATE_EPOCH from the commit (build arg).
#
# CARGO_PROFILE (build arg): `release` (default; what release.yml ships:
# thin LTO, one codegen unit, stripped) or `ci` (Cargo.toml [profile.ci]:
# same code, faster to compile; CI's installer/docker checks only).

# Base images are pinned by digest (the tag stays in the reference so
# Dependabot's docker ecosystem can propose both together).
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS node-base
FROM rust:1.99-alpine@sha256:b1d5dd5a22a09404d3e798c0cf051b689077360374eb505fa5bb93c479693d87 AS rust-base
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99 AS runtime-base

FROM node-base AS portal
WORKDIR /src/portal
COPY portal/package.json portal/package-lock.json ./
RUN npm ci
COPY portal/ ./
RUN npm run build

# W33-b: the admin app (sign-in page + console), built on its own.
FROM node-base AS admin
WORKDIR /src/admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci
COPY admin/ ./
# The console shows the panel version (vite.config.ts reads ../Cargo.toml).
COPY Cargo.toml /src/Cargo.toml
RUN npm run build

FROM rust-base AS chef
RUN apk add --no-cache musl-dev gcc make cmake perl linux-headers mimalloc2
# rustc on Alpine is a musl program and musl's allocator makes it several
# times slower on this crate; mimalloc for the build tools only (the output
# is unchanged: the static binary links no preloaded library).
ENV LD_PRELOAD=/usr/lib/libmimalloc.so.2
ARG CARGO_CHEF_VERSION=0.1.78
RUN cargo install cargo-chef --locked --version ${CARGO_CHEF_VERSION} \
 && rm -rf /usr/local/cargo/registry
WORKDIR /src

FROM chef AS planner
COPY Cargo.toml Cargo.lock build.rs ./
COPY src src
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS deps
ARG CARGO_PROFILE=release
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    CARGO_PROFILE_RELEASE_LTO=thin \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    CARGO_PROFILE_RELEASE_STRIP=true \
    RUSTFLAGS="--remap-path-prefix=/src=/akari --remap-path-prefix=/usr/local/cargo=/cargo"
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --profile "$CARGO_PROFILE" --locked --recipe-path recipe.json

FROM deps AS builder
ARG CARGO_PROFILE=release
ARG AKARI_GIT_SHA=unknown
ENV AKARI_GIT_SHA=${AKARI_GIT_SHA}
COPY Cargo.toml Cargo.lock build.rs ./
COPY proto proto
COPY migrations migrations
COPY src src
COPY deploy/systemd deploy/systemd
COPY --from=portal /src/portal/dist portal/dist
COPY --from=admin /src/admin/dist admin/dist
RUN cargo build --profile "$CARGO_PROFILE" --locked \
 && cp "target/$CARGO_PROFILE/akari" /akari

# Empty data dir owned by the runtime user (distroless has no shell to mkdir
# with); a named volume mounted on /data inherits this ownership.
FROM --platform=$BUILDPLATFORM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS datadir
RUN mkdir -m 0750 /data

FROM scratch AS artifact
COPY --from=builder /akari /akari

FROM runtime-base AS prebuilt
ARG TARGETARCH
COPY --chown=65532:65532 --chmod=0555 dist/akari-linux-${TARGETARCH} /akari
COPY --from=datadir --chown=65532:65532 /data /data
VOLUME /data
WORKDIR /
EXPOSE 8080 8443
ENTRYPOINT ["/akari"]
CMD ["serve"]

FROM runtime-base AS runtime
COPY --from=builder --chown=65532:65532 --chmod=0555 /akari /akari
COPY --from=datadir --chown=65532:65532 /data /data
VOLUME /data
# data_dir defaults to ./data, i.e. /data
WORKDIR /
EXPOSE 8080 8443
ENTRYPOINT ["/akari"]
CMD ["serve"]
