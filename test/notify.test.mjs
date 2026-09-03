// The alerting rules, driven through the real scripts/notify.mjs.
//
// Every case here is a run sequence: write a health summary, run notify.mjs
// against a state file, and read what it decided from its output and from the
// state it leaves behind. No alert credentials are configured, so notify.mjs
// prints the email it would have sent instead of sending one, which is exactly
// what these assertions read.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const NOTIFY = path.resolve("scripts/notify.mjs");

function probe(name, outcome, extra = {}) {
  const base = { name, audience: "students", why: "because", ...extra };
  if (outcome === "pass") return { ...base, ok: true, outcome: "pass", detail: "ok" };
  return { ...base, ok: false, outcome, error: "attempt 1: something" };
}

// Runs notify.mjs once over the given probe results and returns its stdout plus
// the state it wrote.
function run(dir, results) {
  const summaryFile = path.join(dir, "health-summary.json");
  const stateFile = path.join(dir, "health-state.json");
  const outputFile = path.join(dir, "github-output.txt");
  const failed = results.filter((r) => r.outcome === "fail").length;
  fs.writeFileSync(summaryFile, JSON.stringify({
    checkedAt: new Date().toISOString(),
    total: results.length,
    failed,
    inconclusive: results.filter((r) => r.outcome === "inconclusive").length,
    results
  }));
  const stdout = execFileSync(process.execPath, [NOTIFY], {
    encoding: "utf8",
    env: {
      ...process.env,
      HEALTH_SUMMARY_FILE: summaryFile,
      HEALTH_STATE_FILE: stateFile,
      GITHUB_OUTPUT: outputFile,
      ALERT_BACKEND_URL: "",
      ALERT_SHARED_SECRET: ""
    }
  });
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  // GitHub hands each step a fresh $GITHUB_OUTPUT; this file is reused across
  // the runs in one test, so only the newest line belongs to this run.
  const lines = fs.existsSync(outputFile)
    ? fs.readFileSync(outputFile, "utf8").split("\n").filter(Boolean)
    : [];
  const output = lines.length ? lines[lines.length - 1] : "";
  return { stdout, state, output, mailed: stdout.includes("SUBJECT:") };
}

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jys-uptime-"));
}

test("a probe that fails once and passes next produces no email and no issue", () => {
  const dir = workspace();
  const first = run(dir, [probe("skill-writing", "fail"), probe("gateway-root", "pass")]);
  assert.equal(first.mailed, false, "the first failing run must not email anyone");
  assert.match(first.stdout, /HOLDING skill-writing/);
  assert.equal(first.output.trim(), "confirmed_outage=false",
    "the workflow must not open an outage issue or go red on one flap");
  assert.equal(first.state.down["skill-writing"].unconfirmed, true);

  const second = run(dir, [probe("skill-writing", "pass"), probe("gateway-root", "pass")]);
  assert.equal(second.mailed, false, "recovery from an unreported failure must stay silent");
  assert.match(second.stdout, /FLAP skill-writing/);
  assert.equal(second.state.down["skill-writing"], undefined);
  assert.equal(second.output.trim(), "confirmed_outage=false");
});

test("a probe failing twice in a row emails once, dated from the first failure", () => {
  const dir = workspace();
  const first = run(dir, [probe("skill-writing", "fail")]);
  assert.equal(first.mailed, false);
  const since = first.state.down["skill-writing"].since;

  const second = run(dir, [probe("skill-writing", "fail")]);
  assert.equal(second.mailed, true, "a failure confirmed by a second run must be reported");
  assert.match(second.stdout, /SUBJECT: JYS is down: skill-writing/);
  assert.match(second.stdout, new RegExp(`DOWN SINCE:\\s+${since}`),
    "the reported downtime must start at the first failure, not the second");
  assert.equal(second.state.down["skill-writing"].unconfirmed, false);
  assert.equal(second.output.trim(), "confirmed_outage=true");

  // A third failing run is the same outage, not a new one. (With no alert
  // credentials configured nothing is ever stamped as notified, so the reminder
  // is always due here; what matters is that it is reported as still down.)
  const third = run(dir, [probe("skill-writing", "fail")]);
  assert.match(third.stdout, /SUBJECT: JYS is still down: skill-writing/);
  assert.doesNotMatch(third.stdout, /SOMETHING JUST BROKE/);
  assert.equal(third.output.trim(), "confirmed_outage=true");
});

test("the two correctness probes still alert on their first failure", () => {
  for (const name of ["model-answers-stay-private", "student-canary-full-access"]) {
    const dir = workspace();
    const first = run(dir, [probe(name, "fail")]);
    assert.equal(first.mailed, true, `${name} must not wait for a second run`);
    assert.equal(first.state.down[name].unconfirmed, false);
    assert.equal(first.output.trim(), "confirmed_outage=true");
  }
});

test("a probe that only ran out of time is not an outage, until it keeps doing it", () => {
  const dir = workspace();
  for (const runs of [1, 2]) {
    const result = run(dir, [probe("role-rush-backend", "inconclusive")]);
    assert.equal(result.mailed, false, `run ${runs}: an abort is not proof of an outage`);
    assert.equal(result.output.trim(), "confirmed_outage=false");
    assert.equal(result.state.unjudged["role-rush-backend"].runs, runs);
    assert.equal(result.state.down["role-rush-backend"], undefined);
  }
  // Three consecutive runs with no answer at all is enough to stop excusing it.
  const third = run(dir, [probe("role-rush-backend", "inconclusive")]);
  assert.equal(third.mailed, true, "a service that has been unanswerable for three runs is down");
  assert.equal(third.output.trim(), "confirmed_outage=true");

  // And it recovers like anything else.
  const fourth = run(dir, [probe("role-rush-backend", "pass")]);
  assert.match(fourth.stdout, /SUBJECT: JYS is working again: role-rush-backend/);
  assert.equal(fourth.state.unjudged["role-rush-backend"], undefined);
  assert.equal(fourth.output.trim(), "confirmed_outage=false");
});

test("a confirmed outage that recovers still says so", () => {
  const dir = workspace();
  run(dir, [probe("skill-writing", "fail")]);
  run(dir, [probe("skill-writing", "fail")]);
  const back = run(dir, [probe("skill-writing", "pass")]);
  assert.match(back.stdout, /SUBJECT: JYS is working again: skill-writing/);
  assert.equal(back.output.trim(), "confirmed_outage=false");
});

test("a summary from an older health.mjs, with no outcome field, still works", () => {
  const dir = workspace();
  const legacy = { name: "skill-writing", audience: "students", why: "because", ok: false, error: "attempt 1: boom" };
  const first = run(dir, [legacy]);
  assert.equal(first.mailed, false);
  const second = run(dir, [legacy]);
  assert.equal(second.mailed, true);
});
