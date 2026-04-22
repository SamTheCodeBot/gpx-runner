# Stage 1: Download the OSM file using a full Ubuntu image
FROM ubuntu:24.04 AS fetcher

WORKDIR /data

# Download Sweden OSM extract (~800MB) — Ubuntu has curl/wget by default
RUN apt-get update && apt-get install -y curl && \
    curl -sL https://download.geofabrik.de/europe/sweden-latest.osm.pbf -o sweden.osm.pbf && \
    ls -lh sweden.osm.pbf

# Stage 2: Build OSRM artifacts using osrm-backend image
FROM osrm/osrm-backend AS builder

WORKDIR /data

# Copy downloaded OSM file from fetcher stage
COPY --from=fetcher /data/sweden.osm.pbf .

# Extract, partition, customize (runs once at build time — 15-25 min)
# The resulting .osrm files are baked into the image.
# At runtime only osrm-routed runs, which needs ~400MB RAM.
RUN osrm-extract -p /optimum.lua sweden.osm.pbf && \
    osrm-partition sweden.osm.pbf && \
    osrm-customize sweden.osm.pbf && \
    ls -lh *.osrm* && \
    rm sweden.osm.pbf

# Stage 3: Runtime — minimal image with just osrm-routed
FROM osrm/osrm-backend

WORKDIR /data

# Copy preprocessed OSRM files from builder stage
COPY --from=builder /data/*.osrm* .

EXPOSE 5000

# osrm-routed reads the .osrm files in the same dir
CMD ["osrm-routed", "--algorithm", "mld", "/data/sweden.osm.pbf"]