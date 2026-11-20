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

## Open after the Nov 17, 2026 cutover
- Delete the stale `/home/matt/glovesup.tv` on the Linode (first-attempt copy with local package edits). Only when Matt says so.
- Nginx uses `proxy_pass http://localhost:3000` and the app binds 127.0.0.1. Works today (health returns 200). If 502s appear, change it to `http://127.0.0.1:3000`.
- Confirm main blocks direct pushes (the PR page shows a rule with 0 required approvals).
- `npm audit` shows 9 findings (4 moderate, 3 high, 2 critical) on the dev box. Review in the Dec 7 monthly update session.
- Optional deploy.yml hardening: add `permissions: contents: read` and a test job gate. Tests run on the dev box only; the Action has no gate.
- Worker cron output needs a log file and rotation. Decide in the worker slice. Cron runs as `glovesup` with absolute paths.
- DB roles: split an owner role (runs migrations, owns tables) from a least-privilege app role (runtime queries). Today the dev box uses one role, `glovesup_dev`, for the dev and test databases.
- Old databases `glovesup` and `gloveleague` on the dev box can be dropped when Matt says so. Do not drop before then.
- Remove `dotenv` from package.json once confirmed unused (Node loads env files with `--env-file`).
- Old archive at ~/Downloads/Glovesup arch has Privacy_Policy.md, Terms_of_Service.md, ELO_Reference.md. Review for reuse later.

## Slice 1a (register and log in), Nov 17, 2026
- Age gate uses the server's UTC calendar date as "the day of signup". In US evening hours UTC is already the next day, so someone turning 13 tomorrow (local) can pass a few hours early. Not in the docs; left as is.
- After an under-13 refusal nothing stops the person from going back and entering a different date. Not in the docs; no retry block built.
- Does joining a team also need a verified email? The S-P8 subtitle says "Verify your email to call out and join teams"; spec section 8 and the verification banner name call outs and voting only. Decide before the teams slice.
- Nav links to screens not built yet (Battle log, Teams, Leaderboards, Battles) show the 404 page until their slices.
- A form body over 10 kB is refused, but shows the generic "Something went wrong" page (500) instead of a 413 message.
- After registering, the user goes to the log-in page with an "Account created" notice; there is no automatic login.
- Banned, suspended and deleted accounts get the generic "Wrong email, username or password." message at login, so a banned user is not told why. How they learn about a ban and reach an appeal (F-G2) is undecided.
- A user who is banned or suspended while logged in is treated as logged out on their next request. The session row stays until it expires; a sign-out-everywhere action comes with the session list.
- Active-session list (S-M4, `sessions` table) not built. Deferred with MFA and lockout.

## Production
- A test account exists in the production database. Delete it before launch, only when Matt says so.
- The Linode has 20 pending OS updates (3 security) and needs a reboot. Do both in the Dec 7, 2026 monthly update session.
- The production DOB_ENC_KEY is stored in Matt's password manager. Losing it loses every stored DOB.

## Slice 2a (call outs), Nov 20, 2026
- More than one open call out between the same two players is allowed. The docs do not say whether to limit it.
- The 400-point band is checked when the call out is created or edited, not again at accept. Ratings do not move until slice 2d; decide before then whether accept rechecks it.
- "Rating at stake +N −N" on S-B2 is hidden until slice 2d (ELO). `lib/elo.js` is built there.
- Team call outs (3v3) wait for the teams slice. `battles.challenger_team_id` and `opponent_team_id` get their foreign keys then.
- Rules not enforced yet because their tables do not exist: judges barred from ELO call outs (roles), blocked users cannot call out the blocker (blocks), call out emails (F-H7), audit log rows for call out actions (F-H3).
- Expiry runs without the worker: actions refuse a call out past `expires_at`, and page loads mark the viewer's past-due call outs expired. The worker slice takes this over.
