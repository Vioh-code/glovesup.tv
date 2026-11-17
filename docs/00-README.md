# GlovesUP V1 documentation set

Read these in order when starting work. They are written to be read by Claude Code.

| File | What it is |
|---|---|
| 01-feature-spec.md | What V1 does: 31 features (F- IDs), business rules, roles, risks |
| 02-data-model.md | Tables, fields, relationships, deletion rules |
| 03-state-flows.md | Timers, status lifecycles, judge panel, reversals, implementation decisions |
| 04-permissions-matrix.md | Which role can do what |
| 05-screen-inventory.md | The 46 screens (S- IDs) and shared elements |

## Conventions
- `F-` = feature ID (F-C1). `S-` = screen ID (S-B1). They are different namespaces.
- `†` = inferred, not yet confirmed. No dagger = decided.
- Behavior conflicts: 01-feature-spec wins. Layout conflicts: the wireframe wins.
- Anything not in the V1 list in 01-feature-spec is V2. Do not build it.
- Timers run from a `scheduled_jobs` table processed by a one-minute worker.
- Dropdowns over typed text whenever the answer comes from a fixed set (see 05-screen-inventory).
