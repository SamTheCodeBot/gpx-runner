import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { requireUid, UnauthorizedError } from "@/lib/ingestion/auth";
import { listConnections, publicConnectionView } from "@/lib/ingestion/connections";
import { listConsents } from "@/lib/ingestion/consent";
import { retentionSummary } from "@/lib/ingestion/retention";
import { ACTIVITY_COLLECTION, RAW_PAYLOAD_COLLECTION, ROUTE_COLLECTION } from "@/lib/ingestion/store";
import { exportProjectsForOwner } from "@/lib/streetProjects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Right of access and data portability (GDPR Art. 15 and Art. 20).
 *
 * Returns everything held about the caller in a structured, machine-readable
 * form, in one request. Not a support ticket, not a CSV of summaries: the
 * actual records, including full GPS geometry, so the user can take their
 * training history somewhere else.
 *
 * `?includeRaw=1` additionally embeds the original provider files. They are off
 * by default only because they are large and duplicate the parsed geometry.
 *
 * Provider credentials are never included: they are our secrets for accessing a
 * third party on the user's behalf, not the user's personal data, and echoing
 * them would be a security hole dressed as compliance.
 */
export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = adminDb();
    const includeRaw = req.nextUrl.searchParams.get("includeRaw") === "1";

    const [profileById, profileByField, activitySnap, routeSnap, connections, consents, streetProjects] =
      await Promise.all([
        db.collection("userProfiles").doc(uid).get(),
        db.collection("userProfiles").where("userId", "==", uid).get(),
        db.collection(ACTIVITY_COLLECTION).where("ownerUid", "==", uid).get(),
        db.collection(ROUTE_COLLECTION).where("userId", "==", uid).get(),
        listConnections(uid),
        listConsents(uid),
        // The areas chosen, not OSM's street geometry: which towns a person
        // chases is personal data, the map of them is not ours to export.
        exportProjectsForOwner(uid),
      ]);

    const profiles = [
      ...(profileById.exists ? [{ id: profileById.id, ...profileById.data() }] : []),
      ...profileByField.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    ];

    // Strip the stored OAuth blob from the legacy profile shape: same reason as
    // above, tokens are not part of a data export.
    const safeProfiles = profiles.map((profile) => {
      const copy = { ...profile } as Record<string, unknown>;
      if (copy.strava && typeof copy.strava === "object") {
        const strava = copy.strava as Record<string, unknown>;
        copy.strava = {
          athleteId: strava.athleteId,
          athleteName: strava.athleteName,
          scope: strava.scope,
          connectedAt: strava.connectedAt,
        };
      }
      return copy;
    });

    const rawSnap = includeRaw
      ? await db.collection(RAW_PAYLOAD_COLLECTION).where("ownerUid", "==", uid).get()
      : null;

    const rawPayloadSnap =
      rawSnap ?? (await db.collection(RAW_PAYLOAD_COLLECTION).where("ownerUid", "==", uid).select(
        "id",
        "activityId",
        "source",
        "format",
        "byteSize",
        "storedAt",
        "retention",
      ).get());

    const body = {
      export: {
        generatedAt: new Date().toISOString(),
        subjectUid: uid,
        format: "gpx-runner.export.v1",
        includesRawProviderFiles: includeRaw,
      },
      // What we hold and why, restated with the data so the export is
      // self-describing rather than requiring the user to read docs/gdpr.md.
      processing: {
        controller: process.env.GDPR_CONTROLLER_NAME || "the operator of this GPX Runner deployment",
        contact: process.env.GDPR_CONTACT_EMAIL || null,
        lawfulBasis: {
          providerIngest: "Art. 6(1)(a) consent",
          ownUploadsAndAccount: "Art. 6(1)(b) performance of a contract",
        },
        specialCategoryData:
          "None. Heart rate, HRV, sleep and other health metrics are never ingested or stored.",
        retention: retentionSummary(),
      },
      profiles: safeProfiles,
      activities: activitySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      routes: routeSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      providerConnections: connections.map(publicConnectionView),
      consents,
      rawProviderPayloads: rawPayloadSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      streetProjects,
    };

    return new NextResponse(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="gpx-runner-export-${Date.now()}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("[gdpr/export]", error);
    return NextResponse.json({ error: "Failed to build data export" }, { status: 500 });
  }
}
