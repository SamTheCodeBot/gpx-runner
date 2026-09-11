/**
 * Basemap configuration.
 *
 * CARTO (basemaps.cartocdn.com) started watermarking every keyless tile with
 * "API KEY REQUIRED", so CARTO is only usable with an API key now.
 *
 * Default is plain OSM raster tiles: no key, no watermark, always renders.
 * Set NEXT_PUBLIC_BASEMAP_PROVIDER to pick something else:
 *
 *   osm         (default) OpenStreetMap raster, no key
 *   openfreemap OpenFreeMap positron/dark vector tiles via MapLibre, no key
 *   stadia      Stadia Alidade Smooth (Positron look) - NEXT_PUBLIC_STADIA_API_KEY
 *               or a domain allowlisted in your Stadia account
 *   maptiler    MapTiler Positron - requires NEXT_PUBLIC_MAPTILER_API_KEY
 *   carto       CARTO - requires NEXT_PUBLIC_CARTO_API_KEY
 */

export type BasemapProvider = "osm" | "openfreemap" | "stadia" | "maptiler" | "carto";

const PROVIDERS: BasemapProvider[] = ["osm", "openfreemap", "stadia", "maptiler", "carto"];

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export function getBasemapProvider(): BasemapProvider {
  const configured = process.env.NEXT_PUBLIC_BASEMAP_PROVIDER as BasemapProvider | undefined;
  return configured && PROVIDERS.includes(configured) ? configured : "osm";
}

/**
 * Vector style URL for the MapLibre basemap, or null when raster tiles are used.
 *
 * These styles are served from our own `public/map-styles/` so they can be
 * edited visually in Maputnik (https://maplibre.org/maputnik/) and committed
 * back. They still pull tiles, fonts and sprites from OpenFreeMap.
 */
export function getVectorStyleUrl(darkMode: boolean): string | null {
  if (getBasemapProvider() !== "openfreemap") return null;
  return darkMode ? "/map-styles/gpx-dark.json" : "/map-styles/gpx-light.json";
}

/** Raster tile URL. Also used as the fallback when a vector basemap fails. */
export function getRasterTileUrl(darkMode: boolean): string {
  switch (getBasemapProvider()) {
    case "stadia": {
      const key = process.env.NEXT_PUBLIC_STADIA_API_KEY;
      const style = darkMode ? "alidade_smooth_dark" : "alidade_smooth";
      const base = `https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}{r}.png`;
      return key ? `${base}?api_key=${key}` : base;
    }
    case "maptiler": {
      const key = process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "";
      const style = darkMode ? "darkmatter" : "positron";
      return `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}{r}.png?key=${key}`;
    }
    case "carto": {
      const key = process.env.NEXT_PUBLIC_CARTO_API_KEY;
      const style = darkMode ? "dark_all" : "light_all";
      const base = `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
      return key ? `${base}?api_key=${key}` : base;
    }
    default:
      return "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  }
}

/** Does the raster style already have its own dark theme? */
export function rasterHasDarkStyle(): boolean {
  const provider = getBasemapProvider();
  return provider === "stadia" || provider === "maptiler" || provider === "carto";
}

/**
 * CSS class applied to raster tiles. Plain OSM tiles are far more colourful
 * than the Positron-style basemap this app is designed around, so they get
 * desaturated in light mode and inverted in dark mode. Route polylines are
 * unaffected - the filter only applies to the tile images.
 */
export function getRasterFilterClass(darkMode: boolean): string | undefined {
  if (rasterHasDarkStyle()) return undefined;
  if (darkMode) return "basemap-raster-dark";
  return getBasemapProvider() === "osm" ? "basemap-raster-muted" : undefined;
}

export function getRasterAttribution(): string {
  switch (getBasemapProvider()) {
    case "stadia":
      return `&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> ${OSM_ATTRIBUTION}`;
    case "maptiler":
      return `&copy; <a href="https://www.maptiler.com/">MapTiler</a> ${OSM_ATTRIBUTION}`;
    case "carto":
      return '&copy; <a href="https://carto.com/">CARTO</a>';
    default:
      return OSM_ATTRIBUTION;
  }
}

export function getVectorAttribution(): string {
  return `${OSM_ATTRIBUTION} &copy; <a href="https://openfreemap.org/">OpenFreeMap</a>`;
}
