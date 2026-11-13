# GlovesUP V1 theme + wireframes

Open `index.html` in a browser (relative paths, no server needed).

css/theme.css        fonts, tokens, reset, typography, backgrounds
css/components.css   shared components (header, buttons, cards, pills, rows, tables, forms, judge card, auth, team card, ...)
css/screens.css      page-level layouts only
css/fighter-card.css OPTIONAL fighter card + tier badge from the old build (not linked on any page)
fonts/ images/       woff2 files and sample avatars

Load order on every page: theme.css -> components.css -> screens.css

## Screens (pages/)
From the wireframe PDF:   dashboard, create-callout, judge-panel, battle, score, profile, team-manage, staff-case
Added to cover nav links: login, register, battle-log, leaderboards, teams, team-profile,
                          callout-respond, submit-video, judging-queue, settings, staff-queue
Not drawn: Moderation, Users, Audit log (staff), Account/Notifications (settings), Teams tab on Leaderboards.

The grey "Screen ..." strip at the bottom of each page is a wireframe note (.screen-note). Delete before launch.
