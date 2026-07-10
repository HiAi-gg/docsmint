# hiai-docs unified PostgreSQL image: vector + vectorscale + age + pg_trgm
# in a single database.
#
# Build:   docker compose build postgres
# Versions (latest stable as of 2026-06-29):
#   - PostgreSQL    18.1 (Debian 13 "trixie" base — required so the
#                    glibc on the base image matches the glibc that
#                    Apache AGE's prebuilt `.so` was linked against)
#   - pgvector      0.8.3
#   - pgvectorscale 0.9.0
#   - Apache AGE    1.7.0 (binary copied from apache/age:release_PG18_1.7.0
#                    because AGE 1.7.0 source needs the btree
#                    `graphid_ops` operator class that ships with PG18
#                    — building it from source against a fresh PG
#                    produces an `.so` that fails at runtime with
#                    "operator class graphid_ops does not exist".)
#   - pg_trgm       1.6  (PostgreSQL contrib)
#
# Schema, indexes, and FKs are applied via Drizzle migrations from
# packages/db/src/migrations (run by the one-shot migration job after the
# database is healthy). This image bootstraps extensions and owner-role
# configuration; all application and GraphRAG DDL is owned by Drizzle.

# --- Stage 1: build pgvector + pgvectorscale from source
FROM postgres:18.1 AS builder

ARG PGVECTOR_VERSION=0.8.3
ARG PGVECTORSCALE_VERSION=0.9.0
# pgvectorscale 0.9.0's Cargo.toml requires pgrx 0.16.x; 0.9.8 (the
# version hard-coded in the upstream Makefile) only supports PG13-PG15
# and will not accept --pg18.
ARG PGRX_VERSION=0.16.1

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    bison \
    flex \
    git \
    ca-certificates \
    curl \
    pkg-config \
    libssl-dev \
    libreadline-dev \
    zlib1g-dev \
    libxml2-dev \
    libclang-dev \
    clang \
    postgresql-server-dev-18 \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain (needed for pgvectorscale via pgrx).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    --default-toolchain stable --profile minimal --no-modify-path
ENV PATH="/root/.cargo/bin:/usr/local/bin:${PATH}"

# pgvector (C++) — built from source for the current base.
RUN git clone --depth 1 --branch v${PGVECTOR_VERSION} https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && cd /tmp/pgvector && make -j"$(nproc)" && make install \
    && rm -rf /tmp/pgvector

# cargo-pgrx (the cargo subcommand that builds pgrx extensions).
RUN cargo install --locked --version ${PGRX_VERSION} --root /usr/local cargo-pgrx \
    && cargo pgrx init --pg18 /usr/lib/postgresql/18/bin/pg_config 2>/dev/null || true

# pgvectorscale (Rust via pgrx). We invoke `cargo pgrx install`
# directly with the pg18 feature flag because the upstream Makefile
# only goes up to pg15.
RUN git clone --depth 1 --branch ${PGVECTORSCALE_VERSION} https://github.com/timescale/pgvectorscale.git /tmp/pgvectorscale \
    && cd /tmp/pgvectorscale/pgvectorscale && cargo pgrx install --release --features pg18 \
    && rm -rf /tmp/pgvectorscale /root/.cargo/registry /root/.cargo/git

# --- Stage 2: pull prebuilt Apache AGE 1.7.0 binaries
FROM apache/age:release_PG18_1.7.0 AS age_src

# --- Stage 3: runtime image
FROM postgres:18.1

# pgvector + pgvectorscale (built in the builder stage).
COPY --from=builder /usr/lib/postgresql/18/lib/vector.so /usr/lib/postgresql/18/lib/vector.so
COPY --from=builder /usr/lib/postgresql/18/lib/vectorscale-*.so /usr/lib/postgresql/18/lib/
COPY --from=builder /usr/share/postgresql/18/extension/vector* /usr/share/postgresql/18/extension/
COPY --from=builder /usr/share/postgresql/18/extension/vectorscale* /usr/share/postgresql/18/extension/

# Apache AGE (1.7.0) — copied from the official image.
COPY --from=age_src /usr/lib/postgresql/18/lib/age.so /usr/lib/postgresql/18/lib/age.so
COPY --from=age_src /usr/share/postgresql/18/extension/age* /usr/share/postgresql/18/extension/

# Runtime shared libs without the dev toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY init.sql /docker-entrypoint-initdb.d/00-extensions.sql
COPY 01-runtime-role.sh /docker-entrypoint-initdb.d/01-runtime-role.sh
RUN chmod 0755 /docker-entrypoint-initdb.d/01-runtime-role.sh

EXPOSE 5432
CMD ["postgres"]
