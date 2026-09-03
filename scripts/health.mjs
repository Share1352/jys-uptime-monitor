#!/usr/bin/env node
// JYS uptime check.
//
// Runs every probe in scripts/probes.mjs against the live system and prints a
// per-probe PASS/FAIL line plus a machine-readable summary. Exit code 1 means
// at least one surface is down.
//
// Reads only public surfaces, except the optional student canary, which needs
// CANARY_STUDENT_EMAIL and CANARY_STUDENT_PASSWORD.
import { PROBES, studentCanaryProbe } from "./probes.mjs";

const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 25_000);
const ATTEMPTS = Number(process.env.HEALTH_ATTEMPTS || 3);
// Retries used to be 2s and 4s apart, so all three attempts finished inside
// about six seconds: comfortably inside one Render cold start, which is how a
// merely-sleeping service produced three identical aborts and an outage email.
const RETRY_BASE_MS = Number(process.env.HEALTH_RETRY_BASE_MS || 8_000);
const UA = "jys-uptime-monitor";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wix's edge caches a bad answer per URL, so a retry of the identical URL is
// served the identical failure. Every attempt asks a fresh query string.
function bust(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function request(url, { method = "GET", redirect = "follow", body, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      redirect,
      body,
      signal: controller.signal,
      headers: body
        ? { "user-agent": UA, "Content-Type": "text/plain;charset=utf-8" }
        : { "user-agent": UA }
    });
    return {
      status: response.status,
      url: response.url,
      location: response.headers.get("location") || "",
      body: method === "HEAD" ? "" : await response.text()
    };
  } finally {
    clearTimeout(timer);
  }
}

// A probe that is known to sleep gets its own budget rather than being judged
// on the 25s one every fast page uses.
const budget = (probe) => Number(probe.timeoutMs || TIMEOUT_MS);

const fetchTextFor = (timeoutMs) => (url) => request(bust(url), { timeoutMs });

// Apps Script answers a POST with an HTML echo page often enough that a single
// non-JSON reply is not evidence of an outage. Parse as text, then retry.
const postJsonFor = (timeoutMs) => async function postJson(url, payload) {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { body } = await request(url, { method: "POST", body: JSON.stringify(payload), timeoutMs });
    try { return JSON.parse(body); } catch { last = body; await sleep(attempt * 1_500); }
  }
  throw new Error(`Apps Script never answered with JSON. Last reply began: ${last.slice(0, 160)}`);
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// AbortController fires an AbortError whose message is "This operation was
// aborted"; undici also raises a TimeoutError/ConnectTimeoutError of its own.
function isTimeout(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  const cause = String(error?.cause?.code || "");
  return name === "AbortError" || name === "TimeoutError" ||
    /aborted|timeout|timed out/i.test(message) || /TIMEOUT/i.test(cause);
}

function matches(body, needle) {
  return needle instanceof RegExp ? needle.test(body) : body.includes(needle);
}

async function runProbe(probe) {
  const timeoutMs = budget(probe);
  const fetchText = fetchTextFor(timeoutMs);
  if (probe.kind === "custom") return probe.run(fetchText, postJsonFor(timeoutMs));

  if (probe.kind === "redirect") {
    const { status, location } = await request(bust(probe.url), { redirect: "manual", timeoutMs });
    assert(
      status >= 300 && status < 400,
      `expected a redirect to ${probe.expectLocation}, got HTTP ${status}`
    );
    assert(
      location.startsWith(probe.expectLocation),
      `redirects to ${location || "(no Location header)"} instead of ${probe.expectLocation}`
    );
    return `${status} -> ${location}`;
  }

  const { status, body } = await fetchText(probe.url);
  assert(status === 200, `returned HTTP ${status}`);
  assert(
    body.length >= (probe.minBytes || 0),
    `served only ${body.length} bytes (expected at least ${probe.minBytes})`
  );
  for (const needle of probe.must || []) {
    assert(matches(body, needle), `page no longer contains ${needle}`);
  }
  return `${body.length} bytes`;
}

// One transient blip is not an outage. Only a probe that fails every attempt
// is reported, so the owner's inbox stays believable.
//
// A probe that only ever ran out of time is a third outcome, not a failure. An
// abort proves nothing: the service may be dead, or it may be a free Render dyno
// or an Apps Script deployment taking its first-hit minute. Calling that "down"
// is what put two false "JYS is down" emails in the owner's inbox in nine days.
// It is reported as "could not be judged" and left for notify.mjs, which
// escalates a probe that stays unjudgeable run after run.
async function withRetry(probe) {
  const errors = [];
  let timedOutEveryAttempt = true;
  // The sign-in probe is deliberately single-attempt: the backend allows only
  // 12 sign-ins per 15 minutes per email, and retrying is what exhausts that.
  const attemptLimit = probe.singleAttempt ? 1 : Number(probe.attempts || ATTEMPTS);
  for (let attempt = 1; attempt <= attemptLimit; attempt++) {
    try {
      const detail = await runProbe(probe);
      return { name: probe.name, audience: probe.audience, ok: true, outcome: "pass", attempts: attempt, detail: detail || "ok" };
    } catch (error) {
      if (!isTimeout(error)) timedOutEveryAttempt = false;
      errors.push(`attempt ${attempt}: ${String(error?.message || error)}`);
      if (attempt < attemptLimit) await sleep(Number(probe.retryDelayMs || attempt * RETRY_BASE_MS));
    }
  }
  return {
    name: probe.name,
    audience: probe.audience,
    ok: false,
    outcome: timedOutEveryAttempt ? "inconclusive" : "fail",
    attempts: attemptLimit,
    timeoutMs: budget(probe),
    why: probe.why,
    url: probe.url || "",
    error: errors.join(" | ")
  };
}

const probes = [...PROBES];
const canaryEmail = process.env.CANARY_STUDENT_EMAIL;
const canaryPassword = process.env.CANARY_STUDENT_PASSWORD;
if (canaryEmail && canaryPassword) {
  probes.push(studentCanaryProbe(canaryEmail, canaryPassword));
} else {
  console.log("NOTE canary student credentials are not configured; skipping the sign-in probe.");
}

const startedAt = new Date().toISOString();
const results = [];
for (const probe of probes) results.push(await withRetry(probe));

const failed = results.filter((result) => result.outcome === "fail");
const unjudged = results.filter((result) => result.outcome === "inconclusive");
for (const result of results) {
  if (result.ok) console.log(`PASS ${result.name}: ${result.detail}`);
  else if (result.outcome === "inconclusive") console.log(`SLOW ${result.name}: no answer inside ${result.timeoutMs}ms on any attempt, so it could not be judged: ${result.error}`);
  else console.log(`FAIL ${result.name}: ${result.error}`);
}
const lines = [];
if (failed.length) lines.push(`${failed.length} of ${results.length} probes FAILED: ${failed.map((r) => r.name).join(", ")}`);
if (unjudged.length) lines.push(`${unjudged.length} of ${results.length} probes COULD NOT BE JUDGED (no answer in time, which is not proof of an outage): ${unjudged.map((r) => r.name).join(", ")}`);
if (!lines.length) lines.push(`All ${results.length} probes passed.`);
console.log(`\n${lines.join("\n")}`);

const summary = { checkedAt: startedAt, finishedAt: new Date().toISOString(), total: results.length, failed: failed.length, inconclusive: unjudged.length, results };
console.log(`::HEALTH_JSON::${JSON.stringify(summary)}`);

if (process.env.HEALTH_SUMMARY_FILE) {
  const fs = await import("node:fs");
  fs.writeFileSync(process.env.HEALTH_SUMMARY_FILE, JSON.stringify(summary, null, 2));
}

process.exit(failed.length ? 1 : 0);
