#!/usr/bin/env node
// Turns a health run into an email in jyslearn@gmail.com.
//
// The rule that keeps the alerts believable: mail on a change of state, not on
// every run. A surface that has been down for two hours does not need eight
// identical emails, and a surface that just came back deserves to say so.
// A still-down surface is repeated once every REMIND_HOURS so a real outage
// cannot quietly fall off the bottom of the inbox.
//
// Needs ALERT_BACKEND_URL and ALERT_SHARED_SECRET. Without them it prints what
// it would have sent and exits 0, so a fork or a local run is harmless.
import fs from "node:fs";

const SUMMARY_FILE = process.env.HEALTH_SUMMARY_FILE || "health-summary.json";
const STATE_FILE = process.env.HEALTH_STATE_FILE || "state/health-state.json";
const REMIND_HOURS = Number(process.env.ALERT_REMIND_HOURS || 6);
// A probe that fails once and passes on the next run is a flap, not an outage.
// Four "A JYS app is down" issues were opened and auto-closed between
// 2026-08-24 and 2026-09-03 and every one of them was a false alarm, so a
// failure now has to survive a second consecutive run before anyone is told.
const CONFIRM_RUNS = Number(process.env.ALERT_CONFIRM_RUNS || 2);
// The two correctness probes are exempt. They do not answer "is it up" but "is
// a model answer leaking" and "can a real student still reach their work", and
// a single failure there is worth waking someone for.
const ALERT_IMMEDIATELY = new Set(
  (process.env.ALERT_IMMEDIATELY || "model-answers-stay-private,student-canary-full-access")
    .split(",").map((name) => name.trim()).filter(Boolean)
);
// health.mjs reports a probe that only ever ran out of time as "inconclusive"
// rather than failed, because an abort is not proof of anything. It cannot be
// ignored forever either: a service that has been unanswerable for this many
// consecutive runs is treated as down.
const UNJUDGED_RUNS_BEFORE_OUTAGE = Number(process.env.ALERT_UNJUDGED_RUNS || 3);
const BACKEND = process.env.ALERT_BACKEND_URL || "";
const SECRET = process.env.ALERT_SHARED_SECRET || "";
const RUN_URL = process.env.RUN_URL || "";

const summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));

let state = { down: {}, unjudged: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* first run */ }
state.down = state.down || {};
state.unjudged = state.unjudged || {};

const now = new Date();
const nowIso = now.toISOString();
// A result without an outcome comes from a health.mjs older than the run that
// wrote this state file, and its !ok meant "failed".
const outcomeOf = (result) => result.outcome || (result.ok ? "pass" : "fail");
const failing = new Map(summary.results.filter((r) => outcomeOf(r) === "fail").map((r) => [r.name, r]));
const inconclusive = new Map(summary.results.filter((r) => outcomeOf(r) === "inconclusive").map((r) => [r.name, r]));
const passing = summary.results.filter((r) => outcomeOf(r) === "pass").map((r) => r.name);

// A probe nobody could judge this run. Count the run; once it has been
// unanswerable long enough, stop giving it the benefit of the doubt and treat
// it as down, without making it wait out the confirmation window as well.
for (const [name, result] of inconclusive) {
  const previous = state.unjudged[name] || { since: nowIso, runs: 0 };
  previous.runs += 1;
  previous.error = result.error;
  state.unjudged[name] = previous;
  if (previous.runs >= UNJUDGED_RUNS_BEFORE_OUTAGE) {
    failing.set(name, { ...result, since: previous.since, escalated: true });
  }
}
for (const name of [...passing, ...failing.keys()]) {
  if (!inconclusive.has(name)) delete state.unjudged[name];
}

const newlyDown = [];
const stillDown = [];
const awaitingConfirmation = [];
for (const [name, result] of failing) {
  const previous = state.down[name];
  if (!previous) {
    // First failing run. Record it, say nothing, and see whether it is still
    // failing next time -- unless it is a correctness probe or a probe that has
    // already spent several runs unanswerable, which have waited long enough.
    const immediate = ALERT_IMMEDIATELY.has(name) || result.escalated === true || CONFIRM_RUNS <= 1;
    const since = result.since || nowIso;
    state.down[name] = { since, lastNotifiedAt: null, error: result.error, unconfirmed: !immediate };
    if (immediate) newlyDown.push({ ...result, since });
    else awaitingConfirmation.push(result);
  } else if (previous.unconfirmed) {
    // Still failing on the next run: this one is real. Report it with the
    // original `since`, so the downtime the email states stays honest.
    previous.unconfirmed = false;
    previous.error = result.error;
    newlyDown.push({ ...result, since: previous.since });
  } else {
    previous.error = result.error;
    const last = previous.lastNotifiedAt ? new Date(previous.lastNotifiedAt) : null;
    const dueForReminder = !last || (now - last) / 3_600_000 >= REMIND_HOURS;
    if (dueForReminder) stillDown.push({ ...result, since: previous.since });
  }
}

const recovered = [];
const flapped = [];
// An inconclusive probe counts as recovery only while it is still being given
// the benefit of the doubt. Once it has been escalated into `failing` above it
// is an outage, and must not be deleted from state.down in the same run.
for (const name of [...passing, ...[...inconclusive.keys()].filter((n) => !failing.has(n))]) {
  const previous = state.down[name];
  if (!previous) continue;
  delete state.down[name];
  // Nobody was ever told about an unconfirmed failure, so nobody needs to be
  // told it is over. This is the flap that used to cost an email and an issue.
  if (previous.unconfirmed) flapped.push({ name, since: previous.since });
  else recovered.push({ name, since: previous.since });
}

function since(iso) {
  const minutes = Math.round((now - new Date(iso)) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)} days`;
}

function describe(result) {
  return [
    `WHAT BROKE:  ${result.name}`,
    `WHO IT HITS: ${result.audience}`,
    result.url ? `ADDRESS:     ${result.url}` : null,
    result.since ? `DOWN SINCE:  ${result.since} (${since(result.since)} ago)` : null,
    `WHY IT MATTERS: ${result.why || "(not recorded)"}`,
    `WHAT THE CHECK SAW: ${result.error}`
  ].filter(Boolean).join("\n");
}

const sections = [];
let subject = "";

if (newlyDown.length) {
  const names = newlyDown.map((r) => r.name).join(", ");
  subject = newlyDown.length === 1
    ? `JYS is down: ${newlyDown[0].name} (${newlyDown[0].audience})`
    : `JYS is down: ${newlyDown.length} systems (${names})`;
  sections.push(["SOMETHING JUST BROKE", ...newlyDown.map(describe)].join("\n\n"));
}
if (stillDown.length) {
  if (!subject) {
    subject = stillDown.length === 1
      ? `JYS is still down: ${stillDown[0].name} (${since(stillDown[0].since)})`
      : `JYS is still down: ${stillDown.length} systems`;
  }
  sections.push(["STILL BROKEN", ...stillDown.map(describe)].join("\n\n"));
}
if (recovered.length) {
  if (!subject) {
    subject = recovered.length === 1
      ? `JYS is working again: ${recovered[0].name}`
      : `JYS is working again: ${recovered.length} systems`;
  }
  sections.push(["BACK TO NORMAL", ...recovered.map((r) =>
    `${r.name} is answering again after ${since(r.since)}.`)].join("\n"));
}

state.updatedAt = now.toISOString();
state.lastRun = {
  checkedAt: summary.checkedAt,
  total: summary.total,
  failed: summary.failed,
  inconclusive: summary.inconclusive ?? inconclusive.size
};
fs.mkdirSync(STATE_FILE.replace(/\/[^/]+$/, ""), { recursive: true });

// The workflow opens the outage issue and paints itself red on this, not on the
// health exit code, so a single flap no longer does either.
const confirmedOutage = Object.values(state.down).some((entry) => !entry.unconfirmed);

function persist(code = 0) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `confirmed_outage=${confirmedOutage}\n`);
  }
  process.exit(code);
}

for (const result of awaitingConfirmation) {
  console.log(`HOLDING ${result.name}: first failing run, waiting for the next one before telling anyone. ${result.error}`);
}
for (const entry of flapped) {
  console.log(`FLAP ${entry.name}: failed once at ${entry.since} and is answering again. Nothing was sent.`);
}
for (const [name, entry] of Object.entries(state.unjudged)) {
  console.log(`UNJUDGED ${name}: no answer in time on ${entry.runs} consecutive run(s) since ${entry.since}. Becomes an outage at ${UNJUDGED_RUNS_BEFORE_OUTAGE}.`);
}

if (!sections.length) {
  console.log(`No change of state. ${summary.total - summary.failed}/${summary.total} probes passing; nothing to send.`);
  persist(0);
}

const body = [
  sections.join("\n\n" + "-".repeat(60) + "\n\n"),
  "-".repeat(60),
  `Checked at ${summary.checkedAt}`,
  `${summary.total - summary.failed} of ${summary.total} checks passing.`,
  RUN_URL ? `Full run: ${RUN_URL}` : null,
  "",
  "Sent by the JYS uptime monitor (Share1352/jys-uptime-monitor). It checks every",
  "student and teacher app every 15 minutes and only writes when something changes."
].filter(Boolean).join("\n");

console.log(`SUBJECT: ${subject}\n\n${body}\n`);

if (!BACKEND || !SECRET) {
  console.log("No alert credentials configured, so nothing was emailed.");
  persist(0);
}

// Apps Script answers a POST with an HTML echo page often enough that one
// non-JSON reply is not a failure. Read as text and retry.
async function post(payload) {
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(BACKEND, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { last = text; await new Promise((r) => setTimeout(r, attempt * 2_000)); }
  }
  throw new Error(`alert endpoint never answered with JSON. Last reply began: ${last.slice(0, 160)}`);
}

let sent;
try {
  sent = await post({ action: "system_alert", secret: SECRET, subject, body });
} catch (error) {
  console.error(`Alert email FAILED: ${String(error?.message || error)}`);
  persist(1);
}
if (!sent?.ok) {
  console.error(`Alert email FAILED: ${sent?.error || "unknown error"}`);
  persist(1);
}
console.log(`Alert email sent at ${sent.sentAt}. Remaining daily mail quota: ${sent.remainingQuota}.`);

const stamp = now.toISOString();
for (const result of [...newlyDown, ...stillDown]) {
  if (state.down[result.name]) state.down[result.name].lastNotifiedAt = stamp;
}
persist(0);
