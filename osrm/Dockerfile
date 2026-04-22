# syntax=docker/dockerfile:1

# Stage 1: Download OSM data and clone osrm-backend for profiles
FROM debian:bookworm-slim AS fetcher

WORKDIR /data

# Install curl and git (debian:bookworm-slim has these available)
RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*

# Download Sweden OSM extract (~800MB)
RUN curl -sL https://download.geofabrik.de/europe/sweden-latest.osm.pbf -o sweden.osm.pbf && ls -lh sweden.osm.pbf

# Clone osrm-backend to get the foot profile + lib/ modules
RUN git clone --depth 1 --branch v5.25.0 https://github.com/project-osrm/osrm-backend.git /osrm-src

# Stage 2: Build OSRM artifacts
FROM osrm/osrm-backend AS builder

WORKDIR /data

# Copy OSM file
COPY --from=fetcher /data/sweden.osm.pbf .

# Copy the entire profiles directory (foot.lua + lib/ subdirectory)
COPY --from=fetcher /osrm-src/profiles /profiles

# Set LUA_PATH so that require('lib/...') works
ENV LUA_PATH=/profiles/?.lua;/profiles/lib/?.lua;/profiles/lib/?/init.lua;;

# Extract, partition, customize (runs once at build time — 15-25 min)
RUN osrm-extract -p /profiles/foot.lua sweden.osm.pbf && osrm-partition sweden.osm.pbf && osrm-customize sweden.osm.pbf && ls -lh *.osrm* && rm sweden.osm.pbf

# Stage 3: Runtime
FROM osrm/osrm-backend

WORKDIR /data

COPY --from=builder /data/*.osrm* .

ENV PORT=10000

EXPOSE 10000

CMD osrm-routed --algorithm mld --port $PORT /data/sweden.osm.pbf