# jys-uptime-monitor

The watchdog for every JYS student and teacher app.

**Why this repo is public:** GitHub Actions minutes are metered on *private*
repos, and the JYS account is currently over its limit — every job on every
private JYS repo dies in three seconds with *"recent account payments have
failed or your spending limit needs to be increased"*. A public repo's minutes
are unlimited and free. A watchdog that lives inside the thing it watches goes
down with it, so it lives here instead.

Nothing secret is stored in this repository. The credentials the checks need
are GitHub Actions secrets, and none of them can read student work.

## What runs

| Workflow | Schedule | What it does |
| --- | --- | --- |
| `.github/workflows/health.yml` | every 15 min | Probes every student and teacher surface. Emails jyslearn@gmail.com when something changes. |
| `.github/workflows/ping.yml` | every 10 min | Keeps the free Render backend behind Role Rush warm so the first student of the day does not wait for a cold start. |

## What is checked

`scripts/probes.mjs` is the list. A probe is never just "did it return 200" — a
GitHub Pages site that has lost its build still answers 200 with a 404 page, a
Wix route that has lost its embed still answers 200 with an empty shell, and
Apps Script answers 200 with an HTML echo page when it is unhappy. Every probe
names something that can only be there when the surface actually works.

Covered:

- **Student entry:** `www.jysenglish.com/study`, the `app.jysenglish.com`
  gateway and its `/study/` wrapper, and the study hub app itself.
- **The five skills plus flashcards:** writing, speaking, pronunciation,
  reading, listening, flashcard maker — and the flashcard bundle the shell
  loads.
- **Writing data bundles:** the Task 1, Task 2 and guided-practice banks, which
  load lazily and would otherwise only fail after a student had already signed
  in and picked a task.
- **Exam integrity:** model answers must not appear in the public bundles.
- **Teacher surfaces:** the gateway dashboard entry, the dashboard's own
  sign-in form, `www.jysenglish.com/teacher`, and the `_functions` route the
  published Wix page sends teachers to.
- **Backends:** the Apps Script backend behind sign-in, marking and progress;
  the teacher sign-in route (probed with a deliberately wrong password, so no
  teacher credential is stored anywhere); the Role Rush Render backend; the HR
  route.
- **A real student sign-in.** The canary account signs in against the live
  backend every run and checks that Writing Task 1, Writing Task 2 and Speaking
  are all unlocked. This is the check that proves students can do the work,
  rather than proving a page loaded.

## The alert email

`scripts/notify.mjs` mails **jyslearn@gmail.com** through the writing backend's
`system_alert` route. The email names what broke, who it hits, the address, how
long it has been down, why it matters, and exactly what the check saw.

Mail is sent on a **change of state**, not on every run: once when something
breaks, once every six hours while it stays broken, and once when it comes
back. `state/health-state.json` is what makes that possible, and the workflow
commits it. A GitHub issue labelled `outage` is opened and closed alongside, as
a second channel for the case where mail itself is what is broken.

### What has to happen before you are told

An alert nobody trusts is worse than no alert, so a failure has to earn the
email:

- **A failure is confirmed by a second consecutive run.** The first failing run
  is recorded silently as `unconfirmed`. If the next run passes, the entry is
  deleted and nothing was ever sent. If it fails again, the email goes out dated
  from the *first* failure, so the downtime it states is honest.
- **`model-answers-stay-private` and `student-canary-full-access` are exempt.**
  They are correctness probes, not availability probes, and a single failure
  there is worth an immediate alert.
- **Running out of time is not a failure.** A probe whose every attempt was
  aborted is reported as `SLOW` and counted, not called down: an abort proves
  nothing, and a free Render dyno or an Apps Script deployment waking up looks
  exactly like this. After three consecutive runs with no answer at all it is
  escalated to an outage anyway.
- The outage issue and the red workflow run are gated on the same confirmed
  answer, so a flap does not paint the history red either.

Probes that are known to sleep carry their own timeout instead of the 25s a
static page is judged on: `role-rush-backend` gets 75s and two attempts 20s
apart, and the three Apps Script probes get 60s.

## Secrets

| Secret | What it is |
| --- | --- |
| `ALERT_BACKEND_URL` | The writing backend `/exec` URL that hosts `system_alert`. |
| `ALERT_SHARED_SECRET` | Authenticates the alert. It can do exactly one thing: send mail to jyslearn@gmail.com. |
| `CANARY_STUDENT_EMAIL` | The monitoring student account's sign-in email. |
| `CANARY_STUDENT_PASSWORD` | Its password. |

The canary is a real student row named **"ZZZ Uptime Canary (do not delete)"**
in class **ZZZ SYSTEM MONITORING**. It exists only to be signed in by the
monitor. Deleting it does not break the apps, but it does blind the one check
that proves students can get in.

## Running it by hand

```bash
node scripts/health.mjs            # exit 0 = everything up, 1 = something is down
node --test                         # the alerting rules
```

`exit 1` means a probe answered *wrong*. A probe that never answered at all
exits 0 and prints `COULD NOT BE JUDGED`; `HEALTH_TIMEOUT_MS=1
HEALTH_RETRY_BASE_MS=0 node scripts/health.mjs` forces that condition on
demand.

Without `CANARY_STUDENT_EMAIL` / `CANARY_STUDENT_PASSWORD` it skips the
sign-in probe and checks the public surfaces only. Without `ALERT_BACKEND_URL`
/ `ALERT_SHARED_SECRET`, `scripts/notify.mjs` prints the email it would have
sent instead of sending it.
