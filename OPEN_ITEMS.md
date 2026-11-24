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
- Does accept recheck the 400-point band? Today it is checked at create and edit only. Decide before slice 2d (ELO), when ratings start to move.
- Limit open call outs between the same two players? More than one is allowed today; the docs do not say.
- Cap or rate limit on call outs one member can send (spam risk). Not in the docs.
- What a ban, suspension or deletion does to that member's open call outs and battles (moderation slice, F-G2). Today a call out from a member banned after sending can still be accepted, and edit does not recheck the opponent's status or verification (only the band), so a creator can still edit, even to ELO, against an opponent banned after it was sent.
- Repeat Send window: a same-terms Send within 10 seconds lands on the call out already made. The window is not in the docs; confirm or change it.
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
- The Linode has 20 pending OS updates (3 security) and needs a reboot. Do both in the Dec 7, 2026 monthly update session.
- The production DOB_ENC_KEY is stored in Matt's password manager. Losing it loses every stored DOB.

## Slice 2a (call outs): done, live Nov 24, 2026 (PR #7)
Built: S-B1, S-B2, S-B3, S-M1 call out parts; F-C1, F-C2 (1v1 only). Migration 1796256000000_battles ran on the Linode Nov 24. Open decisions from this slice moved to "Decisions still open". Known gaps left:
- "Rating at stake +N −N" on S-B2 is hidden until slice 2d (ELO). `lib/elo.js` is built there.
- Team call outs (3v3) wait for the teams slice. `battles.challenger_team_id` and `opponent_team_id` get their foreign keys then.
- Rules not enforced yet because their tables do not exist: judges barred from ELO call outs (roles), blocked users cannot call out the blocker (blocks), call out emails (F-H7), audit log rows for call out actions (F-H3).
- Expiry runs without the worker: actions refuse a call out past `expires_at`, and call out page loads mark every past-due call out expired (one query). The worker slice takes this over. Until then an expired call out sorts on Past by `expires_at`.
- S-B2 "Your opponent" card shows the rating only. Battles, record and View profile wait for user stats (F-F2) and the profile slice. The wireframe's "Accepting draws three judges at random" hint is reworded until judges are drawn (slice 2c).
- Header nav is clipped at phone width (375 px); LEADERBOARDS is cut off.

## Slice 2b (submit videos), Nov 24, 2026
- Timer work waits for the worker slice: forfeit or void at a missed submission due date, the daily oEmbed re-check that sets `dead_link`, and the gravestone. Until then a battle past its due date stays `accepted` and shows "Submissions are closed".
- Battle status stays `accepted` through submissions until slice 2c adds the judge panel (Matt, Nov 24). `judging_due_at` and the popular vote clock (both start at the second video) are set in 2c.
- The battle page for players (S-B7) is the S-B2 call out page plus a Battle status card for now. The public battle detail (S-P7) and embedded players come with the battle log slice.
- No rate limit on Check link. Each Check and Submit makes one oEmbed request from the server; only the two players of an open, unlocked battle can trigger it.
- A link must include http:// or https://. "youtu.be/ID" typed without it is refused with the format message.
- Team battles get three slots in the teams slice; today accept creates slot 1 only.
