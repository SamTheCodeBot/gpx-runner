import { createHash } from "crypto";
import { signatureMaterial, type FingerprintInput } from "./trackSignature";

/**
 * Content fingerprint for cross-adapter dedupe.
 *
 * `(source, sourceActivityId)` catches the same provider delivering the same
 * activity twice (a webhook and the reconciliation pull racing each other). It
 * cannot catch the same run arriving from two different providers — the watch
 * file synced to intervals.icu and the same run pushed to Strava are one run
 * with two ids. The fingerprint closes that gap.
 *
 * The sampling and bucketing that make the hash survive provider-to-provider
 * jitter live in `trackSignature.ts`, because the client-side read layer needs
 * exactly the same notion of "the same run" and must not grow a second,
 * divergent copy of it. This file is only the hash on top, and only the server
 * uses it — `crypto` is a node builtin.
 *
 * Role: this hash is the *exact-match fast path*. Because any rounding scheme
 * has boundaries, two descriptions of one run can still land either side of a
 * bucket edge and hash differently — so the hash is not trusted as the only
 * check. `isSameRun` in `trackSignature.ts` follows it with a tolerance-based
 * comparison of start time, distance, duration, start point and sampled shape,
 * which has no boundary behaviour. The exact guarantee for same-provider
 * redelivery remains `(source, sourceActivityId)`, enforced by the Firestore
 * document id.
 */

export type { FingerprintInput };

export function fingerprintTrack(input: FingerprintInput): string {
  return createHash("sha256").update(signatureMaterial(input)).digest("hex").slice(0, 32);
}
