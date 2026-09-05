// The daily management report is watched from outside its own pipeline.
//
// Cloud Scheduler is the only lane since the GitHub recovery slots were deleted
// on 2026-08-25, so a day that produces nothing is invisible unless something
// asks. This drives the real probe against stubbed answers from the bridge.
import assert from "node:assert/strict";
import test from "node:test";
import { PROBES } from "../scripts/probes.mjs";

const probe = PROBES.find((item) => item.name === "daily-report-freshness");

// The probe is a `custom` kind, so health.mjs hands it fetchText/postJson.
function fetchTextReturning(status, payload) {
  return async () => ({ status, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
}

test("the probe exists and is given a cold-start budget", () => {
  assert.ok(probe, "daily-report-freshness must be in the probe list");
  assert.equal(probe.kind, "custom");
  assert.ok(probe.timeoutMs >= 60_000, "the bridge reads a sheet; 25s is not enough");
  assert.ok(probe.why && probe.why.length > 20, "the alert email prints this");
});

test("a fresh report passes and says which one", async () => {
  const detail = await probe.run(fetchTextReturning(200, {
    ok: true, found: true, stale: false, ageHours: 1.2,
    reportDate: "2026-09-03", model: "gemini-3.8-flash", staleAfterHours: 30,
  }));
  assert.match(detail, /2026-09-03/);
  assert.match(detail, /gemini-3\.6-flash/);
});

test("a stale report fails, and the message says how stale", async () => {
  await assert.rejects(
    () => probe.run(fetchTextReturning(200, {
      ok: true, found: true, stale: true, ageHours: 51.4,
      reportDate: "2026-09-01", model: "gemini-3.8-flash", staleAfterHours: 30,
    })),
    /newest healthy report is 2026-09-01 \(51\.4h old, stale after 30h\)/,
  );
});

test("no healthy report at all is a failure of its own", async () => {
  await assert.rejects(
    () => probe.run(fetchTextReturning(200, { ok: true, found: false, stale: true })),
    /no healthy management report has ever been written/,
  );
});

test("a bridge that cannot read the workbook says so, and does not claim a missing report", async () => {
  await assert.rejects(
    () => probe.run(fetchTextReturning(503, { ok: false, error: "sheet unavailable" })),
    (error) => /HTTP 503/.test(error.message) && !/stale|missing report/.test(error.message),
  );
});

test("an HTML answer is reported as one, not parsed into a false pass", async () => {
  await assert.rejects(
    () => probe.run(fetchTextReturning(200, "<html>Google Sign-in</html>")),
    /non-JSON/,
  );
});
