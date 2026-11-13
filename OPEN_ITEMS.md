# GlovesUP V1 open items

All 46 screens are drawn in the wireframe package (index.html and pages/). The wireframes are the record of what is done. This list holds only what is still open. Screen IDs are S- (Screen Inventory), features are F-.

## Design gaps (not drawn yet)
- Hung Up placeholder: needs artwork direction. Used for deleted accounts (profile history, battle logs).
- Empty states: lists with no rows (My battles, My cases, Blocked users, battle log search, and so on).
- Permission gate: what a user sees on a screen they cannot use.
- Verification banner: shown to unverified members. Blocks call outs and voting until verified.
- Report button: only a link on the profile is drawn. Needs a standard placement on battle detail and content.
- ELO badge: plain number only, no player or team mark.
- Leaderboards: Teams tab not drawn (same table as players).
- Team battles: S-J2 and the battle outcome show one pairing. Build repeats it per pairing.

## Decisions still open
- S-B4 Judge panel: own page or a section of S-B7 (marked with a dagger in the Screen Inventory).
- Countdown urgent state (last 24 hours): wireframes set it by hand. Build must compute it.

## Content to supply
- Terms and Privacy text (S-P13).
- Email templates (verification, reset, call out events, judge requests, case updates).

## Deferred to later
- ELO test cases and seed data.
- Timer and job details beyond the one-minute worker over scheduled_jobs.
- Logging design (separate chat).
- Fight card (not V1).
- Score cards and a score card builder (future feature, not in V1).

## Added Nov 13, 2026 (repo reset)
- Node 24: dev box done (24.22.3). Linode still needs Node 24 before the first deploy. Confirm its current version.
- Linode prep: dedicated least-privilege DB role and a fresh database; clean the Linode checkout.
- Full git pull ships docs/, wireframes/, CLAUDE.md and OPEN_ITEMS.md to the Linode. Plan: sparse-checkout on the server. Decide before first deploy.
- Before merging chore/v1-repo-reset into main (the first deploy): clean the Linode checkout, Node 24, Nginx and DB ready, .env values, decide sparse-checkout. Slice PRs target chore/v1-repo-reset until then.
- Optional deploy.yml hardening later: remove workflow_dispatch, add permissions: contents: read, add a test job gate. It works as is.
- Tests run on the dev box only; the Action has no test gate.
- Worker cron output needs a log file and rotation. Decide in the worker slice.
- Confirm on the Linode: Nginx and Postgres versions, backup directory, free disk.
- Old archive at ~/Downloads/Glovesup arch has Privacy_Policy.md, Terms_of_Service.md, ELO_Reference.md. Review for reuse later.

## Added Nov 13, 2026 (slice 0 scaffold)
- DB roles: split an owner role (runs migrations, owns tables) from a least-privilege app role (runtime queries). Today the dev box uses one role, `glovesup_dev`, for both dev and test databases.
- Old databases `glovesup` and `gloveleague` on the dev box can be dropped when Matt says so. Do not drop before then.
- The app no longer uses dotenv; Node loads env files with `--env-file`. Confirm how the systemd unit starts the app (ExecStart and EnvironmentFile). It must run `node --env-file=.env index.js` (or `npm start`) or set EnvironmentFile, or the first deploy starts with no DB settings. Remove dotenv from package.json once confirmed.
- npm 11 skipped bcrypt's install script (node-gyp rebuild) with an install-scripts warning. bcrypt loads on the dev box today. Check `npm ci --omit=dev` on the Linode builds it, before the auth slice.
- `.env.example` still lists reCAPTCHA keys from the old app. Trim it when auth is built.
