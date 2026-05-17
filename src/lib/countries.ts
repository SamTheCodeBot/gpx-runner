import { feature } from "@rapideditor/country-coder";
import type { GPXRoute } from "@/app/types";

export function countryForPoint(lat: number, lng: number): string | null {
  return feature([lng, lat])?.properties.nameEn ?? null;
}

export function routeCountryNames(route: Pick<GPXRoute, "coordinates">): string[] {
  const countries = new Set<string>();
  for (const [lng, lat] of route.coordinates) {
    const country = countryForPoint(lat, lng);
    if (country) countries.add(country);
  }
  return Array.from(countries).sort((a, b) => a.localeCompare(b));
}

export function routeHasCountry(route: Pick<GPXRoute, "coordinates">, country: string): boolean {
  return routeCountryNames(route).includes(country);
}
