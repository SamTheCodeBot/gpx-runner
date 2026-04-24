import { generateRoutes } from "../engine/generateRoute";
import { OsmRoutingProvider } from "../engine/providers/osrm";
import { GenerateRouteInput } from "../types";

export async function generateTrainingRoutes(input: GenerateRouteInput) {
  const osrmUrl = process.env.OSRM_URL ?? "";
  const provider = new OsmRoutingProvider(osrmUrl);
  return generateRoutes(provider, input);
}