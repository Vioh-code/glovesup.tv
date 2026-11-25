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
- Popular vote battles and the judge panel: slice 2c-1 draws judges only for battles with Official judges. A Just for fun battle with Popular vote gets no panel and stays `awaiting_panel` (videos open) until the popular vote slice. 01-feature-spec says both "Every battle gets 3 judges" and "Official judges or popular vote", so this needs Matt's call.
- Does accept recheck the 400-point band? Today it is checked at create and edit only. Decide before slice 2d (ELO), when ratings start to move.
- Limit open call outs between the same two players? More than one is allowed today; the docs do not say.
- Cap or rate limit on call outs one member can send (spam risk). Not in the docs.
- What a ban, suspension or deletion does to that member's open call outs and battles (moderation slice, F-G2). Today a call out from a member banned after sending can still be accepted, and edit does not recheck the opponent's status or verification (only the band), so a creator can still edit, even to ELO, against an opponent banned after it was sent.
- Repeat Send window: a same-terms Send within 10 seconds lands on the call out already made. The window is not in the docs; confirm or change it.
- Rate limit on Check link (S-B5)? Each Check and Submit makes one oEmbed request from the server; only the two players of an open, unlocked battle can trigger it. Not in the docs (from slice 2b).
- Accept a YouTube link typed without http:// or https://? Today "youtu.be/ID" is refused with the format message. Not in the docs (from slice 2b).
- Does joining a team also need a verified email? The S-P8 subtitle says "Verify your email to call out and join teams"; spec section 8 and the verification banner name call outs and voting only. Decide before the teams slice (from slice 1a).

## Content to supply
- Terms and Privacy text (S-P13).
- Email templates (verification, reset, call out events, judge requests, case updates).

## Deferred to later
- ELO test cases and seed data.
- Timer and job details beyond the one-minute worker over scheduled_jobs.
- Logging design (separate chat).
- Fight card (not V1).
- Score cards and a score card builder (future feature, not in V1).
- Per-user time zone setting on the profile page (later slice). Dates show in the browser's time zone until then.

## Open after the Nov 17, 2026 cutover
- Delete the stale `/home/matt/glovesup.tv` on the Linode (first-attempt copy with local package edits). Only when Matt says so.
- Nginx uses `proxy_pass http://localhost:3000` and the app binds 127.0.0.1. Works today (health returns 200). If 502s appear, change it to `http://127.0.0.1:3000`.
- Confirm main blocks direct pushes (the PR page shows a rule with 0 required approvals).
- `npm audit` shows 9 findings (4 moderate, 3 high, 2 critical) on the dev box. Review in the Dec 7 monthly update session.
- Optional deploy.yml hardening: add `permissions: contents: read` and a test job gate. Tests run on the dev box only; the Action has no gate.
- Worker cron output needs a log file and rotation. Decide in the worker slice. Cron runs as `glovesup` with absolute paths.
- DB roles: split an owner role (runs migrations, owns tables) from a least-privilege app role (runtime queries). Today the dev box uses one role, `glovesup_dev`, for the dev and test databases.
- Dev box has no backup of `glovesup_dev` (it was wiped by a test run on Nov 24; tests now refuse any database not ending in `_test`). Take a `pg_dump -Fc` before any destructive dev step. Dev accounts gloverb and gloverc are recreated with `~/dev-seed.js` (outside the repo).
- Old databases `glovesup` and `gloveleague` on the dev box can be dropped when Matt says so. Do not drop before then.
- Remove `dotenv` from package.json once confirmed unused (Node loads env files with `--env-file`).
- Old archive at ~/Downloads/Glovesup arch has Privacy_Policy.md, Terms_of_Service.md, ELO_Reference.md. Review for reuse later.

## Slice 1a (register and log in), Nov 17, 2026
- Age gate uses the server's UTC calendar date as "the day of signup". In US evening hours UTC is already the next day, so someone turning 13 tomorrow (local) can pass a few hours early. Not in the docs; left as is.
- After an under-13 refusal nothing stops the person from going back and entering a different date. Not in the docs; no retry block built.
- Nav links to screens not built yet (Battle log, Teams, Leaderboards, Battles) show the 404 page until their slices.
- A form body over 10 kB is refused, but shows the generic "Something went wrong" page (500) instead of a 413 message.
- After registering, the user goes to the log-in page with an "Account created" notice; there is no automatic login.
- Banned, suspended and deleted accounts get the generic "Wrong email, username or password." message at login, so a banned user is not told why. How they learn about a ban and reach an appeal (F-G2) is undecided.
- A user who is banned or suspended while logged in is treated as logged out on their next request. The session row stays until it expires; a sign-out-everywhere action comes with the session list.
- Active-session list (S-M4, `sessions` table) not built. Deferred with MFA and lockout.

## Production
- A test account (glovera) exists in the production database, email marked verified by hand on Nov 24, 2026. gloverb and gloverc exist only on the dev box. Delete it before launch, only when Matt says so.
- No password reset flow yet; production test account password was reset by hand on the Linode (Nov 24).
- Production submit pages are untested. The Nov 25 smoke test after slice 2b passed, but glovera is the only verified production account, so no accepted battle exists to open S-B5 (Submit video) or the S-B2 Battle status card. Test them once a second verified production account exists (created and verified by hand, only when Matt says so).
- Production has no battles yet: the slice 2b migration backfilled 0 slots.
- The Linode has 20 pending OS updates (3 security) and needs a reboot. Do both in the Dec 7, 2026 monthly update session.
- The production DOB_ENC_KEY is stored in Matt's password manager. Losing it loses every stored DOB.

## Slice 2a (call outs): done, live Nov 24, 2026 (PR #7)
Built: S-B1, S-B2, S-B3, S-M1 call out parts; F-C1, F-C2 (1v1 only). Migration 1796256000000_battles ran on the Linode Nov 24. Open decisions from this slice moved to "Decisions still open". Known gaps left:
- "Rating at stake +N −N" on S-B2 is hidden until slice 2d (ELO). `lib/elo.js` is built there.
- Team call outs (3v3) wait for the teams slice. `battles.challenger_team_id` and `opponent_team_id` get their foreign keys then.
- Rules not enforced yet because their tables do not exist: blocked users cannot call out the blocker (blocks), call out emails (F-H7), audit log rows for call out actions (F-H3). Judges barred from ELO call outs is enforced from slice 2c-1.
- Expiry runs without the worker: actions refuse a call out past `expires_at`, and call out page loads mark every past-due call out expired (one query). The worker slice takes this over. Until then an expired call out sorts on Past by `expires_at`.
- S-B2 "Your opponent" card shows the rating only. Battles, record and View profile wait for user stats (F-F2) and the profile slice. The wireframe's "Accepting draws three judges at random" hint is back from slice 2c-1 (Official judges only).
- Header nav is clipped at phone width (375 px); LEADERBOARDS is cut off.

## Slice 2b (submit videos): done, live Nov 25, 2026 (PR #9)
Built: S-B5, S-B2 Battle status card, S-M1 "Submit your video"; F-C3 (1v1). Migration 1797120000000_submissions ran on the Linode Nov 25 after a backup (indexes and constraints checked). Open decisions from this slice moved to "Decisions still open". Known gaps left:
- Timer work waits for the worker slice: forfeit or void at a missed submission due date, the daily oEmbed re-check that sets `dead_link`, and the gravestone. Until then a battle past its due date stays `awaiting_panel` or `submissions_open` and shows "Submissions are closed".
- Battle statuses after accept came with slice 2c-1 (awaiting_panel, submissions_open, judging). The popular vote clock waits for the popular vote slice.
- The battle page for players (S-B7) is the S-B2 call out page plus a Battle status card for now. The public battle detail (S-P7) and embedded players come with the battle log slice.
- Team battles get three slots in the teams slice; today accept creates slot 1 only.

## Slice 2c-1 (judge panel), built Nov 25, 2026, not merged
Built: roles tables (F-H2 part), the random draw of 3 judges at accept, S-J1 Judge dashboard (Accept and Decline), S-B4 as a section of the battle page, the Judging nav link, the S-M1 judge request item, the ELO bar for judges, `scripts/grant-role.js`, and one transactional status function (awaiting_panel, submissions_open, judging). Migration `1797984000000_judge_panel`. The S-B5 closed-reason wording (slice 2b review finding 3) is fixed: one reason for the notice and every refusal. Known gaps left:
- Recusal waits for slice 2c-2 (Matt, Nov 25). Until then an accepted judge cannot leave a panel.
- No timers yet. A judge who never replies blocks the battle until the worker slice replaces judges (48 hours) and judges who do not pick (5 days). Until then a reply after `respond_by` is still taken (Matt, Nov 25).
- Fewer than 3 free judges: the battle waits. Topping up the panel when judges become free is the worker slice's job. The "moderators and admins are notified" step needs staff roles in use and email (F-H7).
- Moderator and admin sub-ins are deferred (`replaced_by`, `replaced_reason` exist, unused).
- Judges get no email about a request (F-H7). The S-J1 list and the S-M1 item are the only notice.
- The 5-day judging clock is set (`judging_due_at`, `score_due_at`) but nothing acts on it. S-J2 (pick and reason) comes in slice 2c-2; S-J1 shows "Judging opens soon" for battles in judging.
- Battles accepted before this slice (dev box only; production had 0) moved to `awaiting_panel` with no judges drawn; they get a panel only from the worker's top-up.
- Do not build yet (Matt, Nov 25): what happens when the judge role is granted to a member who already has open ELO call outs or battles as a player. Today the grant goes through; that member's open ELO call outs can no longer be accepted, and ELO battles already accepted carry on.
- A judge whose role is revoked, or who is banned or suspended, while on a panel keeps the assignment (it still counts toward the 3) but can no longer reply. Not in the docs.
- Only the permissions this slice enforces are seeded (`battle.elo.enter`, `judge.assignment.respond`). Each later slice adds its own rows. No revoke script; revoke is the admin slice (S-S5).
- `scripts/grant-role.js` grants site roles only. Production use is a manual Linode step, only when Matt says so.
- Team battles: the same 3 judges for all pairings, with the teams slice.
