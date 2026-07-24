# jys-uptime-monitor

Cloud keep-warm pinger for JYS apps.

**Why this exists:** GitHub Actions minutes are metered on *private* repos (3,000 free/mo, shared across all private repos). This repo is **public**, so its Actions minutes are **unlimited and free** and never touch that cap.

`.github/workflows/ping.yml` pings `https://role-rush.jysenglish.com/api/health` every ~10 min so the free Render backend never spins down (no ~60s cold start for the first student). It runs entirely on GitHub's cloud runners — no local machine involved.

A once-a-day `heartbeat` commit keeps the scheduled workflow from being auto-disabled after 60 days of repo inactivity.

To add more apps to keep warm, add another `curl` line in the workflow.
