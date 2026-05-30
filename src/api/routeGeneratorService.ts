import { generateRoutes } from "../engine/generateRoute";
import { OpenRouteServiceProvider } from "../engine/providers/openRouteService";
import { GenerateRouteInput } from "../types";

export async function generateTrainingRoutes(input: GenerateRouteInput) {
  const provider = new OpenRouteServiceProvider(process.env.OPENROUTESERVICE_API_KEY ?? "");
  return generateRoutes(provider, input);
}
