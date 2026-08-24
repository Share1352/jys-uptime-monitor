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
const BACKEND = process.env.ALERT_BACKEND_URL || "";
const SECRET = process.env.ALERT_SHARED_SECRET || "";
const RUN_URL = process.env.RUN_URL || "";

const summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));

let state = { down: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* first run */ }
state.down = state.down || {};

const now = new Date();
const failing = new Map(summary.results.filter((r) => !r.ok).map((r) => [r.name, r]));
const passing = summary.results.filter((r) => r.ok).map((r) => r.name);

const newlyDown = [];
const stillDown = [];
for (const [name, result] of failing) {
  const previous = state.down[name];
  if (!previous) {
    state.down[name] = { since: now.toISOString(), lastNotifiedAt: null, error: result.error };
    newlyDown.push(result);
  } else {
    previous.error = result.error;
    const last = previous.lastNotifiedAt ? new Date(previous.lastNotifiedAt) : null;
    const dueForReminder = !last || (now - last) / 3_600_000 >= REMIND_HOURS;
    if (dueForReminder) stillDown.push({ ...result, since: previous.since });
  }
}

const recovered = [];
for (const name of passing) {
  if (state.down[name]) {
    recovered.push({ name, since: state.down[name].since });
    delete state.down[name];
  }
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
state.lastRun = { checkedAt: summary.checkedAt, total: summary.total, failed: summary.failed };
fs.mkdirSync(STATE_FILE.replace(/\/[^/]+$/, ""), { recursive: true });

if (!sections.length) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  console.log(`No change of state. ${summary.total - summary.failed}/${summary.total} probes passing; nothing to send.`);
  process.exit(0);
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
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  process.exit(0);
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

const sent = await post({ action: "system_alert", secret: SECRET, subject, body });
if (!sent?.ok) {
  console.error(`Alert email FAILED: ${sent?.error || "unknown error"}`);
  process.exit(1);
}
console.log(`Alert email sent at ${sent.sentAt}. Remaining daily mail quota: ${sent.remainingQuota}.`);

const stamp = now.toISOString();
for (const result of [...newlyDown, ...stillDown]) {
  if (state.down[result.name]) state.down[result.name].lastNotifiedAt = stamp;
}
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
