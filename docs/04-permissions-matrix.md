# GlovesUP V1 Permissions Matrix

Doc: 04-permissions-matrix. Related: 01-feature-spec (section 8, Roles), 02-data-model (roles, permissions tables).
Last updated: Nov 13, 2026. Owner: Matt.

## Conventions (read first)
- Roles stack. Every account is a Member. Staff and judges hold extra roles on top. A user can do anything any of their roles allows.
- The Vis and Mem columns are baselines. Jdg, Off, Own and the staff columns show only what each role adds.
- Marks: `Y` allowed. `own` allowed on the user's own account or content only. `NO` explicitly barred even though a lower role has it. `-` not allowed.
- `†` marks an inferred detail, not yet confirmed.
- Team Officer and Team Owner are scoped to one team. Everything else is site-wide.
- This table is a snapshot of the starting data for the roles, permissions and role_permissions tables (F-H2). It is not code.
- Event Organizer is V2 and has no column. Staff accounts must use MFA.

Columns: Vis = Visitor (logged out), Mem = Member, Jdg = Judge, Off = Team Officer, Own = Team Owner, Mod = Moderator, Adm = Admin, Sup = Super Admin, SO = Site Owner.

## 1. Accounts, profiles, and teams
| Action | Vis | Mem | Jdg | Off | Own | Mod | Adm | Sup | SO |
|---|---|---|---|---|---|---|---|---|---|
| Register | Y | - | - | - | - | - | - | - | - |
| Log in, log out, reset password | Y | Y | - | - | - | - | - | - | - |
| View leaderboards, profiles, team profiles, battle logs | Y | Y | - | - | - | - | - | - | - |
| Search teams † | Y | Y | - | - | - | - | - | - | - |
| Edit own profile (including social links), change password and email, manage MFA | - | own | - | - | - | - | - | - | - |
| Hide profile fields, toggle social links public or private | - | own | - | - | - | - | - | - | - |
| Delete own account | - | own | - | - | - | - | - | - | - |
| Request a copy of own data | - | own | - | - | - | - | - | - | - |
| Block and unblock users | - | Y | - | - | - | - | - | - | - |
| Create a team | - | Y | - | - | - | - | - | - | - |
| Apply to a team, accept or decline a team invite | - | Y | - | - | - | - | - | - | - |
| Leave a team | - | own | - | - | - | - | - | - | - |
| Edit team profile | - | - | - | Y | Y | - | Y† | Y† | Y† |
| Approve or deny applications, invite members | - | - | - | Y | Y | - | - | - | - |
| Add, remove, suspend, ban, or kick regular members | - | - | - | Y | Y | - | - | - | - |
| Remove or ban an officer † | - | - | - | - | Y | - | - | - | - |
| Promote or demote officers | - | - | - | - | Y | - | - | - | - |
| Transfer team ownership | - | - | - | - | Y | - | - | - | - |
| Delete a team (only when the owner is the sole member) | - | - | - | - | Y | - | - | - | - |
| See a user's email address † | - | - | - | - | - | - | Y | Y | Y |
| Edit any field on another user's account | - | - | - | - | - | - | Y | Y | Y |
| Reset another user's MFA or password, force logout, unlock | - | - | - | - | - | - | Y | Y | Y |
| Assign the Moderator role † | - | - | - | - | - | - | Y | Y | Y |
| Assign the Admin and Super Admin roles | - | - | - | - | - | - | - | - | Y |

An owner cannot leave a team until ownership passes to an officer. A team is deleted only when the owner is the last member.

## 2. Call outs, battles, and judging
| Action | Vis | Mem | Jdg | Off | Own | Mod | Adm | Sup | SO |
|---|---|---|---|---|---|---|---|---|---|
| Create or accept an ELO call out | - | Y | NO | - | - | - | - | - | - |
| Create or accept a Just for fun call out | - | Y | Y | - | - | - | - | - | - |
| Edit or cancel own call out before accepted, decline a call out sent to you | - | own | - | - | - | - | - | - | - |
| Pick the three-member roster for a team call out | - | - | - | Y | Y | - | - | - | - |
| Submit, cancel, or replace a YouTube video (participants only) | - | own | - | - | - | - | - | - | - |
| Forfeit a battle | - | own | - | Y† | Y† | - | - | - | - |
| Vote in a popular vote (verified, 7-day-old account, 1 completed battle, not a participant) | - | Y | - | - | - | - | - | - | - |
| Accept, decline, or recuse from a judge assignment | - | - | Y | - | - | Y | Y | Y | Y |
| Pick a winner and give a reason (when assigned or subbed in) | - | - | Y | - | - | Y | Y | Y | Y |
| Read judge reasons once all judging is complete | Y | Y | - | - | - | - | - | - | - |
| Apply to be a judge | - | Y | - | - | - | - | - | - | - |
| Approve a judge application (two admins required) | - | - | - | - | - | - | Y | Y | Y |
| Assign the judge role directly, bypassing approval | - | - | - | - | - | - | - | Y | Y |
| Revoke the judge role † | - | - | - | - | - | - | Y | Y | Y |
| Fix a stuck battle † | - | - | - | - | - | - | Y | Y | Y |
| Recommend a result reversal (case notes only) | - | - | - | - | - | Y | Y | Y | Y |
| Start or approve a result reversal (two different admins; the site owner may be one) | - | - | - | - | - | - | Y | Y | Y |

Judges are barred from ELO battles but may enter Just for fun battles that have no official sponsor. A moderator or admin cannot sub in as a judge on a battle they are in †. A reversal changes only after two different admins approve it; no other role can change a result.

## 3. Moderation, cases, and administration
Moderators handle content and user conduct. Admins handle account data, roles, and the audit log.

| Action | Vis | Mem | Jdg | Off | Own | Mod | Adm | Sup | SO |
|---|---|---|---|---|---|---|---|---|---|
| Submit a ticket from the login page (locked out, lost MFA) † | Y | Y | - | - | - | - | - | - | - |
| Submit a report, dispute, appeal, bug, or data request | - | Y | - | - | - | - | - | - | - |
| View and reopen own cases | - | own | - | - | - | - | - | - | - |
| View the case queue, assign, work, resolve, and close cases, add internal notes | - | - | - | - | - | Y | Y | Y | Y |
| Warn, suspend, or ban a user | - | - | - | - | - | Y | Y | Y | Y |
| Lift a ban or suspension, decide ban and suspension appeals | - | - | - | - | - | Y | Y | Y | Y |
| View ban lists | - | - | - | - | - | Y | Y | Y | Y |
| Manage the banned-word list † | - | - | - | - | - | Y | Y | Y | Y |
| Remove a submission or profile content that breaks the rules † | - | - | - | - | - | Y | Y | Y | Y |
| View the audit log and authentication reports | - | - | - | - | - | - | Y | Y | Y |
| View a per-user interaction timeline | - | - | - | - | - | - | Y | Y | Y |
| Compile or export a user's data, confirm a deletion | - | - | - | - | - | - | Y | Y | Y |
| Manage role and permission tables | - | - | - | - | - | - | Y | Y | Y |

Every staff action is written to the audit log with the acting user and a timestamp.
