# Test Cases for GPX Runner Route Generation

## Current Status

The app is deployed at https://gpx-runner.vercel.app

**Working:**
- ✅ Firebase auth
- ✅ Route loading from Firestore
- ✅ Left panel takeover for route suggestion
- ✅ Distance targeting (±1km) - generates ~5.2km for 5km request

**Known Issues:**
- ❌ Missing OPENROUTESERVICE_API_KEY in Vercel - causes 500 error
- ❌ Road-safe fallback not working without API key

---

## Test Case 1: Basic Route Generation (5km New Path)

**Input:**
- Start Point: Derived from center of existing routes (Falkenberg area, Sweden)
- Distance: 5 km
- Route Type: New paths (avoidFamiliar = true)
- GPX Files Loaded: 10 routes from user account

**Expected Behavior:**
- Route follows actual roads/trails (not straight lines)
- Loop closes within 50m of start
- Distance: 4.0 - 6.0 km (±1km)
- Familiarity: 0-20%
- No long out-and-back segments

**Actual Result (without API key):**
```
Error: Missing OPENROUTESERVICE_API_KEY
```

---

## Test Case 2: Familiar Route Generation (5km)

**Input:**
- Start Point: Derived from center of existing routes
- Distance: 5 km
- Route Type: Familiar paths (avoidFamiliar = false)
- GPX Files Loaded: 10 routes

**Expected Behavior:**
- Route uses user's uploaded GPX tracks as familiarity graph
- Familiarity: 80-100%
- Route follows familiar paths where possible

---

## API Contract

### Frontend → Backend Request

**Endpoint:** `POST /api/generate-route`

**Request Body:**
```json
{
  "start": { "lat": 56.90, "lng": 12.49 },
  "targetDistanceKm": 5,
  "toleranceKm": 1,
  "familiarityMode": "new",
  "gpxFiles": [],
  "familiarityTracks": []
}
```

### Backend → Frontend Response

**Success (200):**
```json
{
  "routes": [
    {
      "id": "uuid-string",
      "name": "New Loop - 5.2km",
      "coordinates": [[12.491, 56.905], [12.495, 56.908], ...],
      "distance": 5200,
      "elevationGain": 0,
      "startPoint": [12.491, 56.905],
      "isRoundTrip": true,
      "familiarityScore": 5,
      "score": 85.5,
      "debug": {
        "seed": "...",
        "targetMeters": 5000,
        "distancePenalty": 0.04,
        "familiarityPenalty": 0.05
      }
    }
  ],
  "rejectedCount": 67
}
```

**Error (422):**
```json
{
  "error": "Could not find a road/trail loop that matched the requested distance and familiarity."
}
```

---

## Exact Acceptance Rules

### Required Rules (Must Have)

1. **Loop Closure:** Route must end within 50m of start point
2. **Road/Trail Only:** Must use OSRM/OpenRouteService routing, NO straight-line fallbacks
3. **Distance Tolerance:** Target ±1km (e.g., 5km request → 4.0-6.0km acceptable)
4. **Familiarity - New Mode:** 0-20% overlap with uploaded GPX
5. **Familiarity - Familiar Mode:** 80-100% overlap with uploaded GPX

### Preferred Rules (Should Have)

6. **Out-and-Back Penalty:** Reject routes with >20% repeated segments
7. **Loop Shape Score:** Penalize routes that cut through center repeatedly

---

## Key Files for Debugging

1. **`src/app/page.tsx`** - Frontend: calls `/api/generate-route`, transforms coordinates, renders polyline
2. **`src/app/api/generate-route/route.ts`** - API endpoint: validates request, calls route generator
3. **`src/engine/generateRoute.ts`** - Main engine: generates candidates, filters, scores
4. **`src/engine/candidates.ts`** - Waypoint generation for circular loops
5. **`src/engine/providers/openRouteService.ts`** - OpenRouteService client
6. **`src/components/Map.tsx`** - Leaflet map rendering

---

## How to Test Manually

1. Go to https://gpx-runner.vercel.app
2. Login with: mago@osterhult.com / hejapa78
3. Click "Suggest Route" button
4. Select distance (5km) and route type (New/Familiar)
5. Click "Generate Route"
6. Check browser console for API response

---

## To Add API Key to Vercel

1. Go to Vercel Dashboard → gpx-runner → Settings → Environment Variables
2. Add:
   - Name: `OPENROUTESERVICE_API_KEY`
   - Value: (your OpenRouteService API key)
3. Redeploy the app
