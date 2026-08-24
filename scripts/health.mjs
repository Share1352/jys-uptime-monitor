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
const UA = "jys-uptime-monitor";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wix's edge caches a bad answer per URL, so a retry of the identical URL is
// served the identical failure. Every attempt asks a fresh query string.
function bust(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function request(url, { method = "GET", redirect = "follow", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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

const fetchText = (url) => request(bust(url));

// Apps Script answers a POST with an HTML echo page often enough that a single
// non-JSON reply is not evidence of an outage. Parse as text, then retry.
async function postJson(url, payload) {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { body } = await request(url, { method: "POST", body: JSON.stringify(payload) });
    try { return JSON.parse(body); } catch { last = body; await sleep(attempt * 1_500); }
  }
  throw new Error(`Apps Script never answered with JSON. Last reply began: ${last.slice(0, 160)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function matches(body, needle) {
  return needle instanceof RegExp ? needle.test(body) : body.includes(needle);
}

async function runProbe(probe) {
  if (probe.kind === "custom") return probe.run(fetchText, postJson);

  if (probe.kind === "redirect") {
    const { status, location } = await request(bust(probe.url), { redirect: "manual" });
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
async function withRetry(probe) {
  const errors = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const detail = await runProbe(probe);
      return { name: probe.name, audience: probe.audience, ok: true, attempts: attempt, detail: detail || "ok" };
    } catch (error) {
      errors.push(`attempt ${attempt}: ${String(error?.message || error)}`);
      if (attempt < ATTEMPTS) await sleep(attempt * 2_000);
    }
  }
  return {
    name: probe.name,
    audience: probe.audience,
    ok: false,
    attempts: ATTEMPTS,
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

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(result.ok ? `PASS ${result.name}: ${result.detail}` : `FAIL ${result.name}: ${result.error}`);
}
console.log(
  failed.length
    ? `\n${failed.length} of ${results.length} probes FAILED: ${failed.map((r) => r.name).join(", ")}`
    : `\nAll ${results.length} probes passed.`
);

const summary = { checkedAt: startedAt, finishedAt: new Date().toISOString(), total: results.length, failed: failed.length, results };
console.log(`::HEALTH_JSON::${JSON.stringify(summary)}`);

if (process.env.HEALTH_SUMMARY_FILE) {
  const fs = await import("node:fs");
  fs.writeFileSync(process.env.HEALTH_SUMMARY_FILE, JSON.stringify(summary, null, 2));
}

process.exit(failed.length ? 1 : 0);
