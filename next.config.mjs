/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Only pull in the modules each page actually touches, instead of
    // bundling the whole package barrel file per import.
    //
    // "maplibre-gl" deliberately dropped from this list (2026-10-02): with it
    // enabled, one of maplibre-gl's split chunks served as text/html instead
    // of JavaScript in production (Vercel preview, reproduced in a fresh
    // incognito session, so not a caching artifact) -- "Failed to load module
    // script... non-JavaScript MIME type". The base map, zoom and DOM markers
    // all come from code that still loaded fine, so this broke silently:
    // nothing threw where the owner could see it, route lines just never
    // drew. optimizePackageImports re-splits a package's internals against
    // its own export map; maplibre-gl ships worker/glyph assets outside the
    // usual ESM export shape, which is the kind of package this experimental
    // feature is known to mis-chunk. firebase/leaflet/react-leaflet keep the
    // optimization; they do not have the same asset shape.
    optimizePackageImports: ["firebase", "leaflet", "react-leaflet"],
  },
};

export default nextConfig;
