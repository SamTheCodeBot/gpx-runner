# syntax=docker/dockerfile:1

# Stage 1: Download OSM data and OSRM profile
FROM ubuntu:24.04 AS fetcher

WORKDIR /data

# Install curl and wget
RUN apt-get update && apt-get install -y curl wget git && rm -rf /var/lib/apt/lists/*

# Download Sweden OSM extract (~800MB)
RUN wget -q https://download.geofabrik.de/europe/sweden-latest.osm.pbf -O sweden.osm.pbf && ls -lh sweden.osm.pbf

# Clone osrm-backend to get the foot profile
RUN git clone --depth 1 --branch v5.25.0 https://github.com/project-osrm/osrm-backend.git /osrm-src

# Stage 2: Build OSRM artifacts
FROM osrm/osrm-backend AS builder

WORKDIR /data

# Copy OSM file and foot profile from fetcher
COPY --from=fetcher /data/sweden.osm.pbf .
COPY --from=fetcher /osrm-src/profiles/foot.lua /optimum.lua

# Extract, partition, customize
RUN osrm-extract -p /optimum.lua sweden.osm.pbf && \
    osrm-partition sweden.osm.pbf && \
    osrm-customize sweden.osm.pbf && \
    ls -lh *.osrm* && \
    rm sweden.osm.pbf

# Stage 3: Runtime
FROM osrm/osrm-backend

WORKDIR /data

COPY --from=builder /data/*.osrm* .

EXPOSE 5000

CMD ["osrm-routed", "--algorithm", "mld", "/data/sweden.osm.pbf"]