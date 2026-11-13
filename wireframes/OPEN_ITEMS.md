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
