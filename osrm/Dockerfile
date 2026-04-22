FROM osrm/osrm-backend

WORKDIR /data

# Download Sweden OSM extract (~800MB) using curl
RUN curl -sL https://download.geofabrik.de/europe/sweden-latest.osm.pbf -o sweden.osm.pbf && ls -lh sweden.osm.pbf

# Extract, partition, customize (runs once at build time — 15-25 min)
# The resulting .osrm files are baked into the image.
# At runtime only osrm-routed runs, which needs ~400MB RAM.
RUN osrm-extract -p /optimum.lua sweden.osm.pbf && \
    osrm-partition sweden.osm.pbf && \
    osrm-customize sweden.osm.pbf && \
    ls -lh *.osrm* && \
    rm sweden.osm.pbf

EXPOSE 5000

# osrm-routed reads the .osrm files in the same dir as the .pbf
CMD ["osrm-routed", "--algorithm", "mld", "/data/sweden.osm.pbf"]