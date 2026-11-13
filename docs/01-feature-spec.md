# GlovesUP Feature Spec (V1)

Doc: 01-feature-spec. Related: 02-data-model, 03-state-flows, 04-permissions-matrix, 05-screen-inventory.
Last updated: Nov 13, 2026. Owner: Matt.

## Conventions (read first)
- Feature IDs use the `F-` prefix (example: `F-C1`). Screen IDs use `S-` and live in 05-screen-inventory (example: `S-B1`). `F-B1` (Create team) and `S-B1` (Create call out) are different things.
- `†` marks a detail inferred and not yet confirmed. Everything without `†` is decided.
- If a screen wireframe and this spec disagree on behavior, this spec wins. If they disagree on layout, the wireframe wins.
- Anything not in the V1 list (section 2) is V2 or later. Do not build it.
- Roles and permissions per action are in 04-permissions-matrix. Timers are in 03-state-flows. Fields are in 02-data-model.

## 1. Purpose and definitions
GlovesUP is a competitive gloving platform. Members call out a named opponent, both submit a YouTube video, judges or the community pick the winner, and official battles move ELO. V1 is the core loop (register, call out, accept, submit, judge, ELO, leaderboard) plus the trust and admin tools needed to run it safely.

| Term | Definition |
|---|---|
| Call out | A direct proposition to a named opponent (1v1) or named team (3v3) to hold a battle. Expires after 72 hours. |
| Battle | Two submissions judged against each other. Types: Single (1v1) or Team (3v3), each ELO or Just for fun. |
| Team battle | Three pairings: first listed vs first listed, second vs second, third vs third. Each team's officers pick their own three; neither side has a say in the other's roster. |
| Competition | A bracket (16 or 32 entrants). Deferred to V2. |
| Community event | A competition run by a community member or official member. V2. |
| Judging system | Chosen at draft time: Official judges (3 judges each pick a winner) or Popular community vote. |
| Just for fun | Any battle that does not affect ELO. Judges may enter these. |

## 2. V1 feature list (31 features)
| ID | Feature | V1 scope |
|---|---|---|
| F-A1 | Register and verify | Register, verify email, resend verification, required date of birth with an age gate |
| F-A2 | Log in and out | Login, logout, forgot and reset password, failed-attempt lockout, active-session list |
| F-A3 | Secure account | Change password, change email, MFA (optional for members, required for staff), recovery codes |
| F-A4 | Edit profile | Username (banned-word check), Glover name, avatar, bio, social links (up to 5), profile field visibility |
| F-A5 | Delete account | Self-delete with themed anonymization, request a copy of own data |
| F-A6 | Block and unblock users | Block, unblock |
| F-B1 | Create and edit team | Create, edit profile (owner and officers), tracked change history |
| F-B2 | Team membership | Apply, approve or deny, invite, accept or decline, leave, add, remove, suspend, ban, kick, promote or demote officers |
| F-B4 | Transfer, delete, archive team | Transfer ownership, delete when sole member, archive for history |
| F-B6 | Search teams | Team list and search |
| F-C1 | Call outs | Create to a named opponent or team, edit before accepted, cancel, accept, decline, 72-hour expiry, incoming and outgoing views |
| F-C2 | Choose judging system | Official judges or popular vote, set at draft |
| F-C3 | Submit videos | Submit, cancel, replace before lock, deadline. YouTube links only |
| F-C4 | Judge battles | Randomly drawn judges, pick a winner with a written or video reason, recusal, sub out judges |
| F-C5 | Results and ELO | Result finalization from the judges' majority pick, ELO change on official judging of ELO battles only |
| F-C6 | Forfeit | Either participant |
| F-C8 | Search battle logs | Battle history search. Public to visitors, showing both videos and the judging outcome |
| F-D4 | Invitations | Invite to team (competition invites are V2) |
| F-E1 | Judge application | Apply, two-admin approval, super admin direct assign, revoke |
| F-F1 | Leaderboards | View |
| F-F2 | User stats | View |
| F-G1 | Submit a case | One intake for reports, disputes, appeals, bugs, and tickets |
| F-G2 | Moderation actions | Warn, suspend, ban, lift, handle appeals, ban lists, banned-word list |
| F-G3 | Case review queue | One queue for all case types |
| F-G4 | Case lifecycle | Open, assigned, waiting on user, resolved, closed, reopen, internal staff notes |
| F-H1 | Manage users | Edit any field, MFA reset, password reset, force logout, unlock |
| F-H2 | Roles and permissions | Role-to-permission tables in the database, editable without recoding |
| F-H3 | Audit log | Every action logged with user and timestamp, auth reports, per-user timeline |
| F-H4 | Data requests | Compile a user's data for export, confirm deletion (manual admin process) |
| F-H6 | Fix stuck battles | Admin correction of battles stuck in progress, and two-admin result reversal |
| F-H7 | Email notifications | Verification, reset, call out events, judge requests, case updates |

## 3. V2 parking lot (not a commitment, not in priority order)
| ID | Feature |
|---|---|
| F-A1b | Real age verification and phone verification |
| F-B3 | Custom team application forms |
| F-B5 | Team bulletin board and team messages |
| F-C7 | Public comments on submissions |
| F-C9 | No-show penalties for repeated expired call outs (rules to be defined) |
| F-C5b | ELO decay for inactive accounts |
| F-D4b | Invite users to the website |
| F-F3 | Achievements (admin-defined) |
| F-F4 | Hall of Fame and Hall of Shame |
| F-F5 | Tutorial library |
| F-H5 | Site statistic reports and export |
| F-H6b | Clean up inactive accounts |
| F-H7b | In-site notifications |
| F-G1b | Report types for V2 content (comments, tutorials, hall entries) |
| F-D3 | Brackets: 16 and 32 entrants, ELO or Just for fun, random seeding, 7-day sign-up that auto-closes if not full |
| F-D1 | Create community event (verified email, 1 battle, 1 competition). Admins create official events |
| F-D2 | Register for events |
| F-D4c | Invite users to a competition |

V1 battles that do not affect ELO (Just for fun) use official judges or popular vote.

## 4. Feature rules
| ID | Rules |
|---|---|
| F-A1 | Date of birth is required at signup. Minimum age is 13; younger signups are blocked. DOB is stored encrypted, used only for age checks, and never shown to other users. The user can see their own. Self-declared in V1. |
| F-A2 | Lockout after repeated failed logins. Staff accounts must use MFA. |
| F-A3 | MFA reset is a staff action under F-H1. |
| F-A4 | Username, Glover name and bio are checked against the banned-word list (F-G2). Profile image, username, Glover name and battle history are always public. Email and date of birth are never shown. Social links: up to 5 rows, each a platform dropdown (YouTube, Instagram, TikTok, Facebook, X, Discord, Twitch, Website) plus a URL; one public or private toggle covers all links. Users can hide any other profile field. |
| F-A5 | Anonymization keeps battle history but hard-deletes every identifying field. The account becomes the Hung Up placeholder: a pair of darkened gloves hanging over a wire, in muted monochrome. Also covers the right to a copy of data (F-H4). |
| F-A6 | Blocked users cannot message, invite, or call out the blocker. |
| F-B1 | Every change is logged by user for griefing review and corrections. |
| F-B2 | Leave lives on the user profile. Owner cannot leave without passing ownership to an officer. Owner and officers can add, remove, suspend, ban, invite, and kick. Officers cannot act on other officers †. Applications use a fixed form with a message field in V1. |
| F-B4 | Owner may delete the team only when they are the sole member, and can first kick everyone else, including inactive members. Deleted teams are archived so battle history stays readable. |
| F-B6 | Searchable team list showing ELO and member count. |
| F-C1 | Direct to a named opponent or named team only. No open call outs. Team call outs name three members, picked by each team's own officers. Creator may edit until accepted. Expires after 72 hours. ELO call outs are limited to opponents within 400 ELO above or below the caller, for 1v1 and team battles. Due date is chosen from a dropdown: 3, 5 or 7 days after acceptance. |
| F-C2 | Set when the call out is drafted. Official judges (3 judges each pick a winner) or popular community vote. ELO battles must use official judges. |
| F-C3 | YouTube links only, no hosting or uploads. Validate the URL format, then confirm the video exists and is viewable (see 03-state-flows, YouTube checks). Link, title and thumbnail are saved at submission. Lock at the due date. Judge review videos use the same YouTube-only rule and the same checks. |
| F-C4 | See Judging rules below. Every battle gets 3 judges. Judge reasons become public once all judging is complete. |
| F-C5 | ELO moves only when official judges decide an ELO battle. Popular vote never changes ELO. |
| F-C6 | Counts as a loss on ELO battles. Ends the battle. |
| F-C8 | See Battle log rules below. |
| F-D4 | Team invites only in V1. Competition invites come with events in V2. |
| F-E1 | Two admins approve an application. A super admin can assign the judge role directly, bypassing approval. Judges cannot enter ELO battles. They may enter Just for fun battles that have no official sponsor. |
| F-F1 | See Leaderboard rules below. |
| F-F2 | See User stats rules below. |
| F-G1 | Case types are listed under Case system. |
| F-G2 | Moderators and admins can lift bans and suspensions, and handle appeals and unblocks. |
| F-G3 | One queue for every case type. |
| F-G4 | Lifecycle: open, assigned, waiting on user, resolved, closed, reopen allowed. |
| F-H1 | Only site admins can change another user's account. |
| F-H2 | See Roles. |
| F-H3 | Needed for oversight and for answering data requests. Every action is traceable to a user with a timestamp. |
| F-H4 | Manual admin process in V1: pull all of a user's data, hand it over, or confirm deletion. |
| F-H6 | Admins correct battles stuck past their windows. Reversing a result after an appeal needs two different admins to approve (see ELO). |
| F-H7 | Email only in V1. Provider: Gmail, once the site is ready. |

## 5. Business rules

### Judging
- Every battle gets 3 judges, drawn at random from free judges. Neither side picks judges, approves them, or can ask for different ones.
- A team battle uses the same 3 judges for all three pairings. Each judge picks a winner for every pairing.
- Judges have 48 hours to accept. A judge who declines or does not reply is replaced by another random free judge.
- If fewer than 3 free judges exist, the battle waits. Moderators and admins are notified and can sub in.
- Judges have 5 days to submit their picks once both videos are submitted and the 3 judges have accepted †, then are replaced.
- Judges can recuse themselves. A recused or removed judge is replaced by another random free judge. Moderators and admins can sub in. A moderator or admin cannot sub in on a battle they are in †.
- A judge on the same team as a participant is avoided where possible, but allowed when the pool is too small.
- A judge cannot compete in ELO battles. A judge may enter Just for fun battles that have no official sponsor.
- Each judge picks a winner for every pairing (one pick in a 1v1, three in a team battle). After picking, the judge must give a reason: type it, add a YouTube link to a video of themselves watching and judging, or both. At least one is required. Submitting locks the judgment. The majority of the 3 picks decides each pairing. Popular vote is open to verified members who have completed at least one battle.
- Judge reasons (text and video) become public once all judging is complete.
- An event organizer may request specific judges (V2); each must accept or the slot is filled at random.

### Popular vote safeguards
- Verified members only, minimum account age 7 days, at least one completed battle (ELO or Just for fun).
- One vote per account per battle. Participants and members of the participants' teams cannot vote.
- Results stay hidden until the voting window closes.
- Votes are logged with account, time, and hashed device or IP. Bursts from one source, or many new accounts voting together, flag the battle into the case queue.
- Rate limits on voting actions.
- Admins can void votes and recompute the result. Every void is audit-logged.
- Popular vote never affects ELO.

### ELO
- ELO changes only when official judges decide an ELO battle. Popular vote never does.
- New players and teams start at 1000. K = 32 for individuals and teams.
- A forfeit on an ELO battle is a loss. Judges never earn ELO.
- Team battles change only team ELO, never individual ELO. One ELO score per team, same formula, zero-sum.
- Each of the three pairings is judged individually. The team that wins at least two of three wins the battle.
- A team can only call out teams within 400 ELO above or below its own.
- Result reversal after an appeal: needs approval from two different admins. The site owner counts as one of the two. An admin starts the request (that is approval 1); a second admin approves. No one else can reverse a result. Moderators can recommend a reversal in the case notes only.
- A reversal recalculates ELO for that battle only, by adding ledger rows. Adjustments are logged. Later battles are not recalculated.

### Timing and outcomes
- If a participant misses the submission due date, they forfeit (a loss on ELO battles). If neither submits, the battle is voided with no ELO change.
- The popular vote runs from when the second video is submitted until the 5-day judging window ends.
- ELO or Just for fun is set at draft time and cannot change after acceptance.
- Moderators handle content and user conduct. Admins handle account data, roles and the audit log.

### Call outs
- Direct to a named opponent or named team. No open call outs.
- Valid for 72 hours, then they expire. The creator may edit until the opponent accepts.
- The creator picks the due date from a dropdown: 3, 5 or 7 days after acceptance.
- Repeated expiries will carry a penalty. Rules to be defined (F-C9, V2).

### Team battles
- Each team puts up three members, chosen by that team's own officers.
- Pairings follow listed order: first vs first, second vs second, third vs third.

### Teams
- The owner cannot leave without passing ownership to an officer.
- A team can be deleted only when its owner is the sole member. The owner may kick everyone else first.
- Deleted teams are archived. Battle history stays readable. Every team profile and roster change is logged by user.

### Videos
- YouTube links only. Link, title and thumbnail are stored at submission.
- If a link goes dead or the video is made private, the record shows a gravestone. A better solution is deferred.

### Account deletion
- All identifying information is hard-deleted or anonymized. Battle records stay.
- The account becomes the Hung Up placeholder. Per-user data compilation (F-H4) answers access and deletion requests.

## 6. Rules added for thin features

### Leaderboard rules (F-F1)
- Ranked by ELO, highest first. Ties go to more wins, then the earlier account or team creation date.
- Only players or teams with at least 1 finalized ELO battle appear.
- Banned, suspended and deleted accounts, and archived teams, are hidden.
- Two tabs: Players and Teams. Name search.

### User stats rules (F-F2)
- Player: ELO, ELO record (W-L), Just for fun record (W-L), forfeits, battles judged (judges only).
- Team: ELO, W-L, member count.
- Only finalized battles count.

### Battle log rules (F-C8)
- The public log shows finalized battles only, newest first.
- Filters: name search (player or team), format (1v1 or 3v3), ELO or Just for fun, result (win or loss, for a searched name).
- No date filter in V1.
- Members also get My battles (S-B3) with Incoming, Outgoing, Active and Past tabs.

## 7. Case system
Reports, disputes, appeals, bugs, and tickets share one case system with one queue. A case has a type, a subject (user, submission, battle, or none), a reporter, an assignee, a status, and internal staff notes.

| Case type | Examples |
|---|---|
| Support ticket | General question, account help, MFA reset request, locked out |
| Bug or system issue | Site error, stuck battle, broken video link |
| Report: user | Harassment, cheating, impersonation, inappropriate name |
| Report: content | Submission or other content that breaks rules |
| Result dispute | Challenge a judged result |
| Appeal | Appeal a ban, suspension, or result decision |
| Judge complaint | Bias or misconduct by a judge |
| Data request | Copy of my data, or delete my data |

Lifecycle: open, assigned, waiting on user, resolved, closed, with reopen allowed.

## 8. Roles
Roles and permissions live in database tables: roles, permissions, role-to-permission mapping, and user-to-role assignments with an optional scope (a team ID for team roles). Changing what a role can do is a data edit, not a code change.

| Role | How obtained | Key abilities |
|---|---|---|
| Visitor | Default | Register, log in. View leaderboards, profiles, team profiles, battle logs (both videos and the judging outcome) |
| Member | Verified email and DOB | Core loop, teams, tickets and reports |
| Team Officer | Promoted by owner, scoped to a team | Edit team, manage members, pick battle roster |
| Team Owner | Creator or transfer, scoped to a team | Officer abilities plus transfer, delete, promote |
| Judge | Application plus two-admin approval, or super admin assignment | Judge battles. Barred from ELO battles |
| Event Organizer | V2 | Create community events |
| Moderator | Assigned by admins | Case queue, warn, suspend, ban, lift, handle appeals |
| Admin | Assigned by site owner | Manage users, approve judges, audit log, roles, approve result reversals |
| Super Admin | Assigned by site owner | Everything an Admin can do, plus directly assign judge and organizer roles |
| Site Owner | Account creator | Full control, full audit visibility |

## 9. Accepted risks
- Judge supply at launch. Every battle needs 3 judges. Seed judges through a super admin before launch, or call outs will stall. Moderators and admins can sub in as a backstop.
- Small opponent pool. The 400-point limit applies to 1v1 and teams, so some players and teams may have no valid opponent early on.
- Same-team judges. A small community may force a judge to score a teammate's battle. Log every case.
- Dead YouTube links. Handled with a gravestone marker for now.
- Popular vote can be gamed with new accounts. It never affects ELO, and the safeguards limit the damage.

## 10. Coverage check (original items 1 to 69)
1 Register: F-A1. 2 Create a team: F-B1. 3 Manage team members: F-B2. 4 Join a team: F-B2. 5 Create 1v1 call out: F-C1. 6 Create community event: F-D1 (V2). 7 Manage users: F-H1. 8 Ban users: F-G2. 9 Invite to website: F-D4b (V2). 10 Invite to team: F-D4, F-B2. 11 Delete account: F-A5. 12 Submit a ticket: F-G1, F-G4. 13 Cancel a call out: F-C1. 14 Cancel a submission: F-C3. 15 Submit a video: F-C3. 16 Judge a video: F-C4. 17 (not in V1). 18 Judge a battle: F-C4. 19 Edit profile: F-A4. 20 Change a call out before accepted: F-C1. 21 Decline a battle: F-C1. 22 View user stats: F-F2. 23 Search teams: F-B6. 24 Popular vote: F-C2. 25 Block users: F-A6. 26 Comment on submissions and judging: F-C4 (judge reasons), F-C7 (V2). 27 Search battle logs: F-C8. 28 Achievements: F-F3 (V2). 29 Earn or lose ELO: F-C5. 30 ELO decay: F-C5b (V2). 31-33 Team bulletin board and messages: F-B5 (V2). 34 Team battles: F-C1. 35 Build team applications: F-B3 (V2; V1 uses a fixed form in F-B2). 36 Approve or deny applications: F-B2. 37 Transfer ownership: F-B4. 38 Invite to competition: F-D4c (V2). 39 Leaderboards: F-F1. 40 Site statistic reports: F-H5 (V2). 41 Monitor system logs and auth reports: F-H3. 42 View ban lists: F-G2. 43 Suspend user: F-G2. 44 Compile user interactions: F-H3, F-H4. 45 Export reports: F-H5 (V2). 46 Email notifications: F-H7 (in-site F-H7b, V2). 47 MFA: F-A3. 48 Update bio: F-A4. 49 Add social links: F-A4. 50 Report user: F-G1. 51 Update username: F-A4. 52 Change password: F-A3. 53 Archive info on delete: F-A5. 54 Clean up inactive accounts: F-H6b (V2). 55 Correct stuck battles: F-H6. 56 Sub out judges: F-C4. 57-60, 62 Tutorials: F-F5 (V2). 61 Banned word list: F-G2. 63-66 Hall of Fame and Shame: F-F4 (V2). 67 Verify email: F-A1. 68 Verify age: F-A1 (DOB gate V1, real verification F-A1b V2). 69 Verify phone: F-A1b (V2).
