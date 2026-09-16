# syntax=docker/dockerfile:1
# Rust HTTP/WS 网关。构建上下文为仓库根目录：
#   docker build -f deploy/api.Dockerfile -t music-api .
FROM rust:1.95-bookworm AS builder
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# 依赖缓存层：先拷贝清单预编译依赖
COPY Cargo.toml rust-toolchain.toml ./
COPY crates ./crates
COPY proto ./proto
RUN cargo build --release --bin music-api

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/music-api /usr/local/bin/music-api

ENV HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8080
EXPOSE 8080

ENTRYPOINT ["music-api"]
