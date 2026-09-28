/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Only pull in the modules each page actually touches, instead of
    // bundling the whole package barrel file per import.
    optimizePackageImports: ["firebase", "maplibre-gl", "leaflet", "react-leaflet"],
  },
};

export default nextConfig;
