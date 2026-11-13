# GlovesUP V1

Competitive gloving platform. Members call out a named player or team, both submit a YouTube video, 3 judges (or a popular vote) pick the winner, and official judged ELO battles move ratings. Owner and only developer: Matt (City of Elk City IT).

## Source of truth
Read these before building. If code and docs disagree, stop and ask; do not guess.

| File | Use |
|---|---|
| docs/00-README.md | Index and decisions log |
| docs/01-feature-spec.md | Features (F- IDs), rules, judging rules, ELO |
| docs/02-data-model.md | Tables and fields |
| docs/03-state-flows.md | Timers, battle states, YouTube checks, jobs |
| docs/04-permissions-matrix.md | Who can do what. Enforce on the server, never only in the UI |
| docs/05-screen-inventory.md | Screens (S- IDs), what each shows |
| wireframes/ | Static HTML layout and theme reference. Open pages/ in a browser |
| OPEN_ITEMS.md | Known gaps and open decisions |

Items marked with a dagger in the docs are undecided. Ask before building them.

These files live in this repo and are the master copies. Edit them here, in the same commit as the code.

## Stack
Confirmed from the Nov 13, 2026 stack report and checks on both machines. `[CONFIRM]` means not yet verified. `[NOT SET UP]` means decided but not built yet. Do not guess either.

**Machines**
- Dev box: Ubuntu 24.04 LTS, user `edmin`, repo at `~/glovesup`, local Postgres 16. Nothing is served from it; run Node directly.
- Production (Linode): user `matt`, repo at `/home/matt/glovesup.tv`. Nginx reverse proxy (site `glovesup.tv`), systemd service `glovesup`, Node on port 3000, Postgres. Today it runs the scrapped first attempt. [CONFIRM: Nginx and Postgres versions]
- Domain: glovesup.tv

**Stack**
- Runtime: Node 24 LTS. Dev box is on 24.22.3 (npm 11.19.1). The Linode must be on Node 24 before the first deploy. [CONFIRM: Linode Node version]
- App: Express 4, EJS server-rendered views, Passport (local), express-session with connect-pg-simple, bcrypt.
- Data access: plain `pg` with SQL. Remove Sequelize and pg-hstore in the first slice. [NOT SET UP]
- Database: Postgres. Settings in `.env`: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME. Dev databases `glovesup_dev` and `glovesup_test`. [CONFIRM names]
- Migrations: node-pg-migrate, files in `migrations/`. [NOT SET UP]
- Tests: Node's built-in runner (`node --test`) against `glovesup_test`. No linter. [NOT SET UP]
- Timers: one-minute worker over `scheduled_jobs`, run by cron with `flock -n` so runs never overlap. Cron has a bare PATH, so use absolute paths. [NOT SET UP]
- Bind the app to 127.0.0.1 behind Nginx. The old app listened on all interfaces.

**Commands**
| Task | Command |
|---|---|
| Install | `npm ci` |
| Run dev | `npm run dev` (`node --watch index.js`) [NOT SET UP] |
| Run tests | `npm test` [NOT SET UP] |
| Migrate | `npm run migrate` [NOT SET UP] |
| Back up before any production migration | `sudo -u postgres pg_dump -Fc <DB_NAME> > ~/backups/glovesup-$(date +%F-%H%M).dump` [CONFIRM: backup directory and free disk on the Linode] |
| Deploy | Matt merges a pull request to main. The Action in `.github/workflows/deploy.yml` SSHes to the Linode and runs `git pull --ff-only`, `npm ci --omit=dev`, `sudo systemctl restart glovesup`. |
| Prod logs | `journalctl -u glovesup -n 50` |

**Merge equals deploy**
- The Action only pulls, installs and restarts. It does not run migrations or change `.env`, Nginx, cron or systemd. Those are manual steps on the Linode, done before Matt merges.
- docs/, wireframes/, CLAUDE.md and OPEN_ITEMS.md must not end up on the Linode. [NOT SET UP: plan is git sparse-checkout on the server, see OPEN_ITEMS.md]
- The Linode checkout is one commit behind with local edits to package.json and package-lock.json. Clean it before the first merge. See OPEN_ITEMS.md.

## Session start (every session)
1. `git pull`, confirm the working tree is clean and you are on a feature branch, not main.
2. Run the test suite. If it fails before you change anything, report that first.
3. Read STATE.md (project root, never committed), then the slice you are working on.
4. Do NOT run dependency updates here. See Monthly updates.

## Working rules
- One slice per session: a user-facing path built end to end (schema, server, screen, tests). Build the thin core loop first: register, log in, create call out, accept, submit videos, judge, finalize, ELO move. Widen after.
- Branch per slice, named `slice/<short-name>`. Open a pull request after tests pass. Only Matt merges, in the GitHub UI, because a merge to main deploys to production. Until the first deploy, branch from `chore/v1-repo-reset` and open the PR against it, not main. Nothing deploys from that branch. Matt merges it into main when the Linode is ready.
- Write tests first for rules that cannot be wrong: ELO math (K=32, start 1000), the +/-400 band, 2-of-3 judge majority and 2-of-3 pairings in a team battle, the two-admin reversal, permission checks, 72h/48h/5-day timers.
- Commit small. Commit messages name the IDs touched, for example `S-J2, F-C4: judge pick plus reason`.
- Change a decision in the docs in the same commit as the code. Do not leave docs behind.
- Use the wireframes for layout and the theme tokens in wireframes/css/theme.css. Do not invent new colors or fonts.
- Dropdowns over typing wherever the answer comes from a fixed set.
- Videos are YouTube links only (no uploads). Validate format, then confirm with oEmbed; recheck daily and mark dead_link.
- Keep the repo lean: only files that belong in the deployed project.
- No score cards in V1. Do not add them.

## Stop and wait for Matt's "Done"
Give step-by-step instructions and wait for confirmation before:
- Any database migration against production (take a backup first).
- Changes to the GitHub Action or deploy process.
- Auth, sessions, MFA, passwords, roles or permissions code.
- ELO calculation or result reversal code.
- Any change on the Linode: `.env`, Nginx, cron, systemd, the checkout itself, or package files.
- Anything that deletes data.

For familiar scaffolding (CRUD, wiring, styling), batch steps. Slow to one step at a time for new concepts or troubleshooting. When Matt pastes an error, go straight to diagnosis and a fix.

## Session end (every session)
1. Tests green, branch pushed, pull request opened or updated. List anything Matt must do on the Linode before merging (migration, `.env` values, Nginx, cron).
2. Overwrite STATE.md (do not append): current slice, last finished step, next step, open problems, anything waiting on Matt. Keep it to one screen.
3. Update any docs whose decisions changed. Update OPEN_ITEMS.md.
4. Commit with IDs in the message.

STATE.md is gitignored. Make sure `.gitignore` contains `STATE.md`.

## Monthly updates (first Monday of each month)
A dedicated session, never mixed with feature work. Branch `chore/updates-YYYY-MM`. Update OS packages and dependencies, run the full tests, check for security advisories, note anything skipped and why, merge by pull request.

## Do not
- Commit secrets, .env files or database dumps.
- Merge, run `gh pr merge`, or push to main. Matt merges.
- Run anything against the production server. Give Matt the steps instead.
- Build outside the current slice without asking.
- Chase edge cases not in the docs. Note them in OPEN_ITEMS.md and move on.
