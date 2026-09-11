import type { NextRequest } from "next/server";
import { verifyFirebaseIdToken } from "@/lib/firebaseAuthServer";

/**
 * Bearer-token extraction shared by the ingestion and data-rights routes, so
 * the check exists once rather than being retyped in every handler.
 */

export class UnauthorizedError extends Error {
  constructor(message = "Missing Firebase auth token") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function requireUid(req: NextRequest): Promise<string> {
  const authHeader = req.headers.get("authorization") ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!idToken) throw new UnauthorizedError();

  try {
    const decoded = await verifyFirebaseIdToken(idToken);
    return decoded.uid;
  } catch {
    throw new UnauthorizedError("Invalid Firebase auth token");
  }
}
