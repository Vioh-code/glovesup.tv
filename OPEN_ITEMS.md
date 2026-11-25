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
- Does accept recheck the 400-point band? Today it is checked at create and edit only. Decide before slice 2d (ELO), when ratings start to move.
- Rule until slice 2d is live (Matt, Nov 25, 2026): no ELO call outs in production. Written rule only, no code gate: nothing stops a verified member from sending one, so do not create any. Judge roles in production are allowed; Just for fun battles never touch ratings. Slice 2d: ELO battles finalized before it have no ledger rows; on the dev box they come from the seed script, and production must have none.
- Limit open call outs between the same two players? More than one is allowed today; the docs do not say.
- Cap or rate limit on call outs one member can send (spam risk). Not in the docs.
- What a ban, suspension or deletion does to that member's open call outs and battles (moderation slice, F-G2). Today a call out from a member banned after sending can still be accepted, and edit does not recheck the opponent's status or verification (only the band), so a creator can still edit, even to ELO, against an opponent banned after it was sent.
- Repeat Send window: a same-terms Send within 10 seconds lands on the call out already made. The window is not in the docs; confirm or change it.
- Rate limit on Check link? S-B5 (`/battles/:id/video/check`): each Check and Submit makes one oEmbed request from the server; only the two players of an open, unlocked battle can trigger it (from slice 2b). S-J2 (`/judging/:id/check-link`): the same, for the review video; only a panel judge who may pick now can trigger it (from slice 2c-2). Not in the docs. No limit built.
- Accept a YouTube link typed without http:// or https://? Today "youtu.be/ID" is refused with the format message. Not in the docs (from slice 2b).
- Does joining a team also need a verified email? The S-P8 subtitle says "Verify your email to call out and join teams"; spec section 8 and the verification banner name call outs and voting only. Decide before the teams slice (from slice 1a).

## Content to supply
- Terms and Privacy text (S-P13).
- Email templates (verification, reset, call out events, judge requests, case updates).

## Deferred to later
- ELO test cases and seed data.
- Slice 2d (ELO) notes: add the elo_ledger rows inside `finalize()` in `lib/judging.js` (marked "Slice 2d hook"), in the same transaction, for `scoring = 'elo'` only. Also at the "Slice 2d hook" in `closeSubmissions()` in `lib/worker.js`: a missed-due-date forfeit on an ELO battle adds rows with reason `forfeit` (forfeited_by loses); a void adds none. Decide whether a forfeit uses the normal expected-score formula for the loss. No ELO call outs in production until 2d is live (see Decisions still open). Decide the 400-band recheck at accept first.
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
- Worker cron: decided in the worker slice (Matt, Nov 25): cron as `glovesup`, `flock -n`, absolute paths, output appended to `/var/log/glovesup/worker.log`, logrotate daily, 14 kept. Set up on the Linode with the worker slice PR (see that section).
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
- Production has no battles yet: the slice 2b migration backfilled 0 slots, and the slice 2c-1 migration moved 0 battles to `awaiting_panel`.
- No judge role is granted in production yet. The judge panel (S-B4 section, S-J1 Judging, the S-M1 judge request item, the ELO bar for judges) and the judging flow from slice 2c-2 (S-J2 pick and reason, recusal, finalize, the outcome card, the S-M1 "Judge this battle" item) are untested in production. Testing it needs a verified judge account and a second verified player account, created and verified by hand, only when Matt says so.
- The Linode has 20 pending OS updates (3 security) and needs a reboot. Do both in the Dec 7, 2026 monthly update session.
- The production DOB_ENC_KEY is stored in Matt's password manager. Losing it loses every stored DOB.

## Slice 2a (call outs): done, live Nov 24, 2026 (PR #7)
Built: S-B1, S-B2, S-B3, S-M1 call out parts; F-C1, F-C2 (1v1 only). Migration 1796256000000_battles ran on the Linode Nov 24. Open decisions from this slice moved to "Decisions still open". Known gaps left:
- "Rating at stake +N −N" on S-B2 is hidden until slice 2d (ELO). `lib/elo.js` is built there.
- Team call outs (3v3) wait for the teams slice. `battles.challenger_team_id` and `opponent_team_id` get their foreign keys then.
- Rules not enforced yet because their tables do not exist: blocked users cannot call out the blocker (blocks), call out emails (F-H7), audit log rows for call out actions (F-H3). Judges barred from ELO call outs is enforced from slice 2c-1.
- Expiry: the worker expires call outs every minute (worker slice). Actions still refuse a call out past `expires_at`, and page loads still mark past-due call outs expired, so a page is never a minute behind. An expired call out sorts on Past by `expires_at`.
- S-B2 "Your opponent" card shows the rating only. Battles, record and View profile wait for user stats (F-F2) and the profile slice. The wireframe's "Accepting draws three judges at random" hint is back from slice 2c-1 (Official judges only).
- Header nav is clipped at phone width (375 px); LEADERBOARDS is cut off.

## Slice 2b (submit videos): done, live Nov 25, 2026 (PR #9)
Built: S-B5, S-B2 Battle status card, S-M1 "Submit your video"; F-C3 (1v1). Migration 1797120000000_submissions ran on the Linode Nov 25 after a backup (indexes and constraints checked). Open decisions from this slice moved to "Decisions still open". Known gaps left:
- Forfeit or void at a missed due date, the daily oEmbed recheck (`dead_link`) and the gravestone came with the worker slice. Between the due date and the next worker run (under a minute) the battle shows "Submissions are closed".
- Battle statuses after accept came with slice 2c-1 (awaiting_panel, submissions_open, judging). The popular vote clock waits for the popular vote slice.
- The battle page for players (S-B7) is the S-B2 call out page plus a Battle status card for now. The public battle detail (S-P7) and embedded players come with the battle log slice.
- Team battles get three slots in the teams slice; today accept creates slot 1 only.

## Slice 2c-1 (judge panel): done, live Nov 25, 2026 (PR #11)
Migration `1797984000000_judge_panel` ran on the Linode before the merge, after a backup (6 roles, judge_assignments and the migration record checked; smoke test passed). PR #11 also carried c8fd628 from docs/slice-2b-close, so that commit is already in main and docs/slice-2b-close needs no PR of its own.
Built: roles tables (F-H2 part), the random draw of 3 judges at accept, S-J1 Judge dashboard (Accept and Decline), S-B4 as a section of the battle page, the Judging nav link, the S-M1 judge request item, the ELO bar for judges, `scripts/grant-role.js`, and one transactional status function (awaiting_panel, submissions_open, judging). Migration `1797984000000_judge_panel`. The S-B5 closed-reason wording (slice 2b review finding 3) is fixed: one reason for the notice and every refusal. Known gaps left:
- Recusal came with slice 2c-2.
- Timers came with the worker slice: a judge past `respond_by` (48 hours) or `score_due_at` (5 days) is replaced when a free judge exists; until then a late reply or pick is still taken (Matt, Nov 25).
- Fewer than 3 free judges: the battle waits and the worker tops up the panel when judges become free. The "moderators and admins are notified" step is a daily stuck line in the worker log until staff sub-ins and email (F-H7).
- Moderator and admin sub-ins are deferred (`replaced_by`, `replaced_reason` exist, unused).
- Judges get no email about a request (F-H7). The S-J1 list and the S-M1 item are the only notice.
- The 5-day judging clock (`score_due_at`) is acted on by the worker slice. `judging_due_at` triggers nothing; it is the panel's latest date.
- Battles accepted before this slice (dev box only; production had 0) moved to `awaiting_panel` with no judges drawn; the worker's top-up draws their panel on its first run (if their due date has not passed; otherwise they are forfeited or voided first).
- Do not build yet (Matt, Nov 25): what happens when the judge role is granted to a member who already has open ELO call outs or battles as a player. Today the grant goes through; that member's open ELO call outs can no longer be accepted, and ELO battles already accepted carry on.
- A judge whose role is revoked, or who is banned or suspended, while on a panel keeps the assignment (it still counts toward the 3) but can no longer reply. The worker replaces them only through the normal clocks (48 hours drawn, 5 days in judging); an accepted one in `submissions_open` has no clock until judging starts. Not in the docs (worker slice: note only).
- Only the permissions this slice enforces are seeded (`battle.elo.enter`, `judge.assignment.respond`). Each later slice adds its own rows. No revoke script; revoke is the admin slice (S-S5).
- `scripts/grant-role.js` grants site roles only. Production use is a manual Linode step, only when Matt says so.
- Team battles: the same 3 judges for all pairings, with the teams slice.
- Decided (Matt, Nov 25): judge panels are drawn only for battles with Official judges. A Just for fun battle with Popular vote gets no panel and stays `awaiting_panel` (videos open) until the popular vote slice. The popular vote slice must set its own status flow for these battles (they never reach `submissions_open` or `judging` through the panel rules).

## Slice 2c-2 (judging): done, live Nov 25, 2026 (PR #13)
Migration `1798848000000_judgments` ran on the Linode before the merge, after a backup (judgments table, `judge_assignments.recused_at`, the 5 `judge.judgment.submit` grants and the migration record checked). Smoke test passed: `/judging` as glovera shows "Only judges", health ok. Browser test on the dev box passed (picks, video-only review, 2-of-3 finalize, outcome card, S-J1 history); recusal is covered by tests only.
Built: S-J2 (pick plus a typed reason, a checked YouTube review video, or both; Check link; Submit locks), the 2-of-3 majority and finalize (slot and battle result, finalized_at, reasons_public_at; team rule as a tested function for the teams slice), recusal (S-J1 and S-J2), the outcome card on the battle page with judge usernames after finalize, "Judged" on S-B4, S-J1 Ready to judge, Judge and View, and the S-M1 "Judge this battle" item. The settle() fix: a seat is an accepted or scored assignment. Migration `1798848000000_judgments` (judgments, judgment_pick, judge_assignments.recused_at, the battles finalized check, the judge.judgment.submit seed). Known gaps left:
- ELO does not move on finalize (slice 2d hook in `finalize()`).
- Picks, recusals and finalize write no audit log rows (F-H3 not built) and send no email (F-H7).
- A judge who never picks is replaced by the worker after `score_due_at` when a free judge exists; until then a pick after it is still taken. No replacement free: the battle waits and shows in the daily stuck log (the `stuck` status and S-S10 come with F-H6).
- Battle videos are rechecked daily by the worker (judges judge whatever is linked; a dead one shows the gravestone). Judge review videos are not rechecked (Matt, Nov 25): they are hidden until finalize and rechecks stop at finalize.
- Moderator and admin sub-ins stay deferred: those roles hold `judge.judgment.submit` but there is no route to sub in.
- The outcome shows to the two players and the panel judges only. Visitors read it on the public battle page (S-P7) in the battle log slice, which reads `reasons_public_at`.
- S-J2 shows video thumbnails and links, no embedded players (CSP frame-src, battle log slice).
- S-J2 reason fields always show, without JavaScript (the wireframe shows them after the pick).
- Rate limit on Check link: `/judging/:id/check-link` is in the Check link item under "Decisions still open". No limit built.
- Team battle judging waits for the teams slice: `finalize()` and `teamResult()` handle three slots, but the S-J2 form and submit take one slot, so a team battle throws until the teams slice builds the three-pick form.
- The S-B4 hint and the S-B3 Past tab do not show who won yet (Past shows "Finalized"). Recent results on S-M1 wait for a later slice.
- Production: no judge role granted yet, so the judging flow is untested there (see Production). The rule stands: no ELO call outs in production until slice 2d is live.

## Worker slice (timers): built Nov 25, 2026, not live
Built: `scripts/worker.js` and `lib/worker.js` (the one-minute worker, sweeping the due columns; no `scheduled_jobs` table), call out expiry, forfeit or void at a missed due date (F-C1, F-C3, F-C6 part), judge replacement after 48 hours and 5 days, panel top-up, the daily oEmbed recheck (`dead_link` and back), the gravestone on S-B5, S-B2 and S-J2, the S-B2 Result card for forfeits and voids, the S-J1 "Time ran out" message, `npm run worker:dev`. Migration `1799712000000_worker` (`judge_assignments.replaced_at`, the replaced_reason, forfeit and void checks, four partial indexes). Known gaps left:
- Linode not set up: migration, log folder, logrotate, crontab. Steps are in the PR. Until the cron runs, production has no timers (it has no battles today).
- The explicit Forfeit button (F-C6, S-B6) comes in a later slice (after 2d, since it states the ELO loss).
- Team battles: the due-date close logs an error for a team battle and leaves it (teams slice); replacement, top-up and the stuck report skip team battles.
- No `stuck` status: stuck battles are a daily log line (12:00 UTC) until F-H6. If the 12:00 or a minute-0 run is skipped (flock), that day's report or that hour's heartbeat is missed.
- A battle that stays stuck is looked at again every minute. Each handler takes at most 100 battles per run, so with over 100 stuck battles newer ones would wait. Not a concern at today's size.
- Error lines in the log carry the database error message, which can include a value from the row. The log is readable by `glovesup` only (0640). The separate logging design chat may change the format.
- The gravestone shows the saved title, not the saved thumbnail (05 marks the thumbnail †).
- Popular vote battles with both videos in stay `awaiting_panel` until the popular vote slice; the worker leaves them alone.
- Dev box: run `npm run migrate` before using the new code on `glovesup_dev`.

