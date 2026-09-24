import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { OverpassError, runOverpassQuery } from "../src/lib/overpass";

/**
 * How the Overpass client fails.
 *
 * Every test here exists because a runner saw something. The one that named
 * the file: tapping a road to add it to a project answered "AbortError: This
 * operation was aborted", which is a browser API talking about itself while
 * the runner is trying to find out what happened to his street.
 *
 * Underneath it was a chain. Overpass runs a slot system and says 429 when all
 * four are busy, freeing one within seconds. The client read that as a reason
 * to step down to the next mirror — and the mirrors are a thirty-eight second
 * server and one that does not answer at all, inside a fifty-second budget. By
 * the time the ladder reached its last rung there were two seconds left, which
 * was still treated as enough to open a socket with. It was not. It was enough
 * to abort with.
 */

type StubCall = { url: string; body: string };

function jsonResponse(payload: unknown) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  };
}

function rateLimited(retryAfterSeconds?: number) {
  return {
    status: 429,
    ok: false,
    headers: { get: (name: string) => (name.toLowerCase() === "retry-after" && retryAfterSeconds ? String(retryAfterSeconds) : null) },
    text: async () => "",
  };
}

function abortError(): Error {
  // What an AbortController produces, without needing one.
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

const realFetch = globalThis.fetch;
let calls: StubCall[] = [];

function stubFetch(handler: (call: StubCall, index: number) => unknown) {
  calls = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const call: StubCall = { url: String(url), body: String((init as { body?: string })?.body ?? "") };
    const index = calls.length;
    calls.push(call);
    const result = handler(call, index);
    if (result instanceof Error) throw result;
    return result as Response;
  }) as typeof fetch;
}

/** A query no other test and no earlier run has cached. */
function uniqueQuery(label: string): string {
  return `[out:json];node(1);out;//${label}-${Math.random().toString(36).slice(2)}`;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("what the runner is told when Overpass does not answer", () => {
  it("never shows him the abort, because the abort is ours", async () => {
    stubFetch(() => abortError());

    const error = await runOverpassQuery(uniqueQuery("abort"), {
      deadlineAt: Date.now() + 12_000,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(error instanceof OverpassError, "an abort has to arrive as an Overpass failure");
    assert.doesNotMatch(error.message, /abort/i, "AbortError is a fact about fetch, not about his project");
    assert.match(error.message, /try again/i, "tell him what to do next");
    assert.equal(error.code, "busy");
  });

  it("does not open a socket it has no time to wait on", async () => {
    stubFetch(() => jsonResponse({ elements: [] }));

    const error = await runOverpassQuery(uniqueQuery("nobudget"), {
      // Three seconds are reserved for building the response, leaving two —
      // enough to start a request, never enough to finish one.
      deadlineAt: Date.now() + 5_000,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(error instanceof OverpassError);
    assert.equal(calls.length, 0, "a doomed attempt is worse than no attempt: it costs the time it fails in");
    assert.match(error.message, /try again/i);
  });
});

describe("a rate limit is a slot, not a refusal", () => {
  it("waits the slot out and asks the same server again", async () => {
    stubFetch((_call, index) => (index === 0 ? rateLimited(1) : jsonResponse({ elements: [{ id: 7 }] })));

    const payload = await runOverpassQuery(uniqueQuery("slot"), { deadlineAt: Date.now() + 40_000 });

    assert.deepEqual(payload, { elements: [{ id: 7 }] });
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].url,
      calls[1].url,
      "the server that said 429 is the fast, current one — stepping down to a stale mirror costs more than the wait",
    );
  });
});

describe("an endpoint that never answers", () => {
  it("is left out of the rotation rather than retried into the deadline", async () => {
    // Whichever endpoint this process currently favours — earlier tests in
    // this file have already taught it things, which is the point of the
    // memory being per-process.
    stubFetch(() => jsonResponse({ elements: [] }));
    await runOverpassQuery(uniqueQuery("probe"), { deadlineAt: Date.now() + 45_000 });
    const silent = calls[0].url;

    stubFetch((call) => (call.url === silent ? abortError() : jsonResponse({ elements: [] })));
    const answer = await runOverpassQuery(uniqueQuery("down"), { deadlineAt: Date.now() + 45_000 });

    assert.deepEqual(answer, { elements: [] });
    assert.equal(calls[0].url, silent, "it is tried once");
    assert.ok(calls.length >= 2, "and the next endpoint answers");

    // Now that it has been seen to be silent, the next request skips it.
    stubFetch((call) => (call.url === silent ? abortError() : jsonResponse({ elements: [] })));
    await runOverpassQuery(uniqueQuery("down-again"), { deadlineAt: Date.now() + 45_000 });

    assert.ok(
      calls.every((call) => call.url !== silent),
      "a server that is not there does not get to spend another request's budget proving it",
    );
  });
});
