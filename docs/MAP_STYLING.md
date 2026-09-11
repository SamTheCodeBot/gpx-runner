# Map styling

The basemap is configured in `src/lib/basemap.ts` and rendered by
`src/components/BaseMapLayer.tsx` (used by both `Map.tsx` and `MapAdmin.tsx`).

## Providers

Set `NEXT_PUBLIC_BASEMAP_PROVIDER` in the environment:

| Value         | Tiles                                   | API key                        |
| ------------- | --------------------------------------- | ------------------------------ |
| `osm`         | OpenStreetMap raster (default)           | none                           |
| `openfreemap` | OpenFreeMap vector, our own style JSON   | none                           |
| `stadia`      | Stadia Alidade Smooth (Positron look)    | `NEXT_PUBLIC_STADIA_API_KEY`   |
| `maptiler`    | MapTiler Positron / Dark Matter          | `NEXT_PUBLIC_MAPTILER_API_KEY` |
| `carto`       | CARTO Positron / Dark Matter             | `NEXT_PUBLIC_CARTO_API_KEY`    |

CARTO without a key is not usable: it bakes an "API KEY REQUIRED" watermark
into every tile image.

Raster tiles are filtered in CSS (`globals.css`): plain OSM is desaturated in
light mode (`.basemap-raster-muted`) and inverted in dark mode
(`.basemap-raster-dark`). The filter applies to tile images only, so route
polylines keep their colours.

## Editing our own vector style

With `NEXT_PUBLIC_BASEMAP_PROVIDER=openfreemap` the app loads style JSON from
our own domain:

- `public/map-styles/gpx-light.json`
- `public/map-styles/gpx-dark.json`

Both started as the OpenFreeMap Positron / Dark styles and still pull vector
tiles, fonts and sprites from OpenFreeMap, so editing them costs nothing and
needs no account.

To change how the map looks:

1. Open [Maputnik](https://maplibre.org/maputnik/).
2. `Open` -> `Load from URL` and paste the deployed style URL, e.g.
   `https://<your-domain>/map-styles/gpx-light.json`.
   For local work, run `npm run dev` and use `http://localhost:3000/map-styles/gpx-light.json`.
3. Edit layers (colours, which roads show at which zoom, label sizes, what to
   hide entirely). Useful edits for this app: mute road casings so route
   polylines stand out, drop POI layers, lighten landuse fills.
4. `Export` -> `Download style` and replace the file in `public/map-styles/`.
5. Commit. No rebuild of the map code is needed - the style is a static asset.

Keep `glyphs`, `sprite` and the `openmaptiles` source URLs pointing at
`tiles.openfreemap.org` unless you are switching tile hosts too.

## Fallback behaviour

The vector basemap is not trusted blindly. If WebGL is unavailable, the style
errors, or nothing has painted after 6 seconds, `BaseMapLayer` removes the
vector layer and renders raster tiles instead, so the map is never left blank.
Check the browser console for `[basemap]` warnings when that happens.
