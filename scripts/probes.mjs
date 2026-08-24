// Every surface a JYS student or teacher has to be able to reach.
//
// A probe is deliberately more than "did it return 200". A GitHub Pages site
// that has lost its build still answers 200 with a 404 page, a Wix route that
// has lost its embed still answers 200 with an empty shell, and Apps Script
// answers 200 with an HTML echo page when it is unhappy. Each probe therefore
// names something that can only be present when the surface actually works.

export const PAGES = "https://share1352.github.io";
export const WRITING = `${PAGES}/jys-writing-trainer-static`;
export const GATEWAY = "https://app.jysenglish.com";
export const SITE = "https://www.jysenglish.com";
export const BACKEND =
  "https://script.google.com/macros/s/AKfycbz-CXv-1cZpDufVN0XAVZRYMNgObjRelEHIG5BHeQgf3hTVAwsFNuwnLTOZCtJyt9FzEQ/exec";

// audience is what the alert email says is affected, so the owner can tell a
// student outage from a teacher outage without reading the probe name.
export const PROBES = [
  // ---- student entry points -------------------------------------------------
  { name: "site-study-hub-route", audience: "students", kind: "html",
    url: `${SITE}/study`, minBytes: 50_000, must: [/JYS/i],
    why: "The address students are given. Wix serves it." },
  { name: "gateway-root", audience: "students and teachers", kind: "html",
    url: `${GATEWAY}/`, minBytes: 800, must: [/Study Hub/i, /Teacher Dashboard/i],
    why: "The JYS-owned front door that lists both platforms." },
  { name: "gateway-study", audience: "students", kind: "html",
    url: `${GATEWAY}/study/`, minBytes: 300, must: [`${PAGES}/jys-study-hub/`],
    why: "Must still frame the real study hub." },
  { name: "study-hub-app", audience: "students", kind: "html",
    url: `${PAGES}/jys-study-hub/`, minBytes: 20_000, must: [/JYS Study/i, "script.google.com"],
    why: "The hub itself, with its sign-in wired to the backend." },

  // ---- the five skills ------------------------------------------------------
  { name: "skill-writing", audience: "students", kind: "html",
    url: `${WRITING}/`, minBytes: 100_000, must: ["var BACKEND =", /JYS/i],
    why: "Writing app shell plus the backend it talks to." },
  { name: "skill-speaking", audience: "students", kind: "html",
    url: `${PAGES}/jys-ielts-speaking-master-list/web/`, minBytes: 20_000, must: [/IELTS Speaking/i],
    why: "Speaking master list: 41 topics, recording and test mode." },
  { name: "skill-pronunciation", audience: "students", kind: "html",
    url: `${PAGES}/jys-pronunciation-lab/`, minBytes: 5_000, must: [/JYS/i],
    why: "Speak Clearly pronunciation course." },
  { name: "skill-reading", audience: "students", kind: "html",
    url: `${PAGES}/jys-reading-practice-/`, minBytes: 5_000, must: [/JYS/i],
    why: "Reading practice app." },
  { name: "skill-listening", audience: "students", kind: "html",
    url: `${PAGES}/jys-listening-practice/`, minBytes: 5_000, must: [/JYS/i],
    why: "Listening practice app." },
  { name: "skill-flashcards", audience: "students", kind: "html",
    url: `${PAGES}/jys-flashcard-maker/`, minBytes: 2_000, must: [/flashcard/i, "./app.js"],
    why: "Vocabulary flashcard maker. The page is a small shell; app.js is the app." },
  { name: "skill-flashcards-bundle", audience: "students", kind: "html",
    url: `${PAGES}/jys-flashcard-maker/app.js`, minBytes: 100_000, must: ["React"],
    why: "The precompiled flashcard bundle the shell loads." },

  // ---- writing app data bundles --------------------------------------------
  // These load lazily, so a broken bundle only bites after a student has
  // already signed in and picked a task. Probe them directly.
  { name: "writing-bundle-task1", audience: "students", kind: "html",
    url: `${WRITING}/data/task1.js`, minBytes: 1_000, must: ["D.T1"],
    why: "Task 1 prompt bank." },
  { name: "writing-bundle-task2", audience: "students", kind: "html",
    url: `${WRITING}/data/task2.js`, minBytes: 1_000, must: ["D.T2"],
    why: "Task 2 prompt bank." },
  { name: "writing-bundle-practice", audience: "students", kind: "html",
    url: `${WRITING}/data/practice.js`, minBytes: 1_000, must: ["window.JYS_DATA"],
    why: "Guided practice steps." },

  // ---- anti-cheat regression guard -----------------------------------------
  { name: "model-answers-stay-private", audience: "the exam integrity of every test", kind: "custom",
    why: "Model answers are server-only. A build that publishes them to Pages hands every student the answers.",
    async run(fetchText) {
      for (const file of ["task1.js", "task2.js"]) {
        const { status, body } = await fetchText(`${WRITING}/data/${file}`);
        if (status !== 200) throw new Error(`data/${file} returned HTTP ${status}`);
        if (body.includes("D.MDL=Object.assign(D.MDL||{},")) {
          throw new Error(`data/${file} is publishing model answers to the public site`);
        }
      }
      return "no model answers in the public bundles";
    } },

  // ---- teacher surfaces -----------------------------------------------------
  { name: "teacher-gateway", audience: "teachers", kind: "html",
    url: `${GATEWAY}/teacher/`, minBytes: 500,
    must: [`${WRITING}/teacher-dashboard.html`, /teacher/i],
    why: "The teacher dashboard entry, framing the guarded dashboard." },
  { name: "teacher-dashboard-app", audience: "teachers", kind: "html",
    url: `${WRITING}/teacher-dashboard.html`, minBytes: 100_000,
    must: ['id="ll"', 'id="lp"', "var BACKEND ="],
    why: "The dashboard itself must still render its sign-in form." },
  { name: "site-teacher-route", audience: "teachers", kind: "html",
    url: `${SITE}/teacher`, minBytes: 50_000, must: [/JYS/i],
    why: "The /teacher address teachers are given. Wix serves it." },
  { name: "site-teacher-route-forwards", audience: "teachers", kind: "redirect",
    url: `${SITE}/_functions/teacherDashboard`, expectLocation: `${GATEWAY}/teacher/`,
    why:
      "The published Wix page for /teacher navigates to this function. Wix stamps " +
      "every _functions response with default-src 'self', which kills an inlined " +
      "dashboard bundle, so this function has to forward to the gateway instead. " +
      "If it stops forwarding, /teacher is a dead page for every teacher." },

  // ---- backends -------------------------------------------------------------
  { name: "backend-ping", audience: "students and teachers", kind: "custom",
    why: "The Apps Script backend behind sign-in, marking, progress and speaking.",
    async run(fetchText) {
      const { status, body } = await fetchText(`${BACKEND}?action=ping`);
      if (status !== 200) throw new Error(`backend ping returned HTTP ${status}`);
      let payload;
      try { payload = JSON.parse(body); }
      catch { throw new Error(`backend ping returned non-JSON: ${body.slice(0, 160)}`); }
      if (payload?.ok !== true) throw new Error(`backend ping was not ok: ${body.slice(0, 160)}`);
      if (payload?.capabilities?.studyActivityV2 !== 1) {
        throw new Error("backend has not deployed the Study Hub activity contract");
      }
      return `backend time ${payload.time}`;
    } },

  { name: "teacher-login-endpoint", audience: "teachers", kind: "custom",
    why:
      "Proves the teacher sign-in path answers, without holding a teacher password " +
      "anywhere. A deliberately wrong password must come back as a clean JSON " +
      "rejection; anything else means the auth route itself is broken.",
    async run(_fetchText, postJson) {
      const payload = await postJson(BACKEND, {
        action: "teacher_login",
        login: "uptime-monitor@jysenglish.invalid",
        password: "not-a-real-password"
      });
      if (payload?.ok === true) throw new Error("teacher_login accepted an invalid credential");
      if (!payload || typeof payload.error !== "string") {
        throw new Error(`teacher_login did not answer with a JSON error: ${JSON.stringify(payload).slice(0, 160)}`);
      }
      return `rejected with ${payload.error}`;
    } },

  { name: "role-rush-backend", audience: "students in speaking games", kind: "custom",
    why: "The Render backend behind the Role Rush speaking game.",
    async run(fetchText) {
      const { status } = await fetchText("https://role-rush.jysenglish.com/api/health");
      if (status !== 200) throw new Error(`role-rush health returned HTTP ${status}`);
      return "healthy";
    } },

  { name: "site-hr-route", audience: "staff", kind: "html",
    url: `${SITE}/hr`, minBytes: 50_000, must: [/JYS/i],
    why: "The HR app route." }
];

// Runs only when a canary student credential is configured. This is the one
// probe that proves a real student can sign in and reach every skill, rather
// than proving a page loaded.
export function studentCanaryProbe(email, password) {
  return {
    name: "student-canary-full-access",
    audience: "every student",
    kind: "custom",
    singleAttempt: true,
    why:
      "Signs a real student account in against the live backend and checks that " +
      "Writing Task 1, Task 2 and Speaking are all unlocked. This is what proves " +
      "students can actually do the work, not just load the page.",
    async run(_fetchText, postJson) {
      // Sign-in is by email; the backend rejects a phone with email_login_required.
      const login = await postJson(BACKEND, { action: "login", login: email, password });
      // The backend allows 12 sign-ins per 15 minutes per email. Hitting that
      // ceiling means the backend is alive and defending itself, which is the
      // opposite of an outage -- reporting it as one cost a false alarm on
      // 2026-08-24. Anything else is a genuine failure.
      if (login?.error === "rate_limited") {
        return "backend is up and rate limiting; sign-in check skipped this run";
      }
      if (!login?.ok) throw new Error(`canary student sign-in failed: ${login?.error || "unknown error"}`);
      const token = login.studentSessionToken;
      if (!token) throw new Error("canary student sign-in returned no session token");
      const phone = login.phone;
      if (!phone) throw new Error("canary student sign-in returned no student record");

      const session = await postJson(BACKEND, {
        action: "student_session_check", phone, studentSessionToken: token
      });
      if (!session?.found) throw new Error("canary student session was not recognised");
      const locked = ["task1Access", "task2Access", "speakingAccess"]
        .filter((field) => !session[field]);
      if (locked.length) {
        throw new Error(`students are locked out of: ${locked.join(", ")}`);
      }

      const speaking = await postJson(BACKEND, {
        action: "speaking_content_access", phone, studentSessionToken: token
      });
      if (!speaking?.ok && speaking?.error !== "rate_limited") {
        throw new Error(`speaking content is locked: ${speaking?.error || "unknown error"}`);
      }
      return "sign-in works and Task 1, Task 2 and Speaking are all open";
    }
  };
}
