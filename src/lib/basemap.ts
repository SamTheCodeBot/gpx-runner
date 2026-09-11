/**
 * Basemap configuration.
 *
 * CARTO (basemaps.cartocdn.com) started watermarking every keyless tile with
 * "API KEY REQUIRED", so the default provider is OpenFreeMap: free, no API key,
 * no usage limits, and the positron/dark styles match the old CARTO look.
 *
 * Override with NEXT_PUBLIC_BASEMAP_PROVIDER = openfreemap | osm | carto
 * (carto additionally needs NEXT_PUBLIC_CARTO_API_KEY).
 */

export type BasemapProvider = "openfreemap" | "osm" | "carto";

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export function getBasemapProvider(): BasemapProvider {
  const configured = process.env.NEXT_PUBLIC_BASEMAP_PROVIDER as BasemapProvider | undefined;
  if (configured === "osm" || configured === "carto" || configured === "openfreemap") {
    return configured;
  }
  return "openfreemap";
}

/** Vector style URL for the MapLibre basemap, or null when using raster tiles. */
export function getVectorStyleUrl(darkMode: boolean): string | null {
  if (getBasemapProvider() !== "openfreemap") return null;
  return darkMode
    ? "https://tiles.openfreemap.org/styles/dark"
    : "https://tiles.openfreemap.org/styles/positron";
}

/** Raster tile URL, used for the `osm`/`carto` providers and as vector fallback. */
export function getRasterTileUrl(darkMode: boolean): string {
  if (getBasemapProvider() === "carto") {
    const key = process.env.NEXT_PUBLIC_CARTO_API_KEY;
    const style = darkMode ? "dark_all" : "light_all";
    const base = `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
    return key ? `${base}?api_key=${key}` : base;
  }
  return "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
}

export function getRasterAttribution(): string {
  return getBasemapProvider() === "carto"
    ? '&copy; <a href="https://carto.com/">CARTO</a>'
    : OSM_ATTRIBUTION;
}

export function getVectorAttribution(): string {
  return `${OSM_ATTRIBUTION} &copy; <a href="https://openfreemap.org/">OpenFreeMap</a>`;
}
