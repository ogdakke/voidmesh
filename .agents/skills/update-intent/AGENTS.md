# Update Intent Nodes

Update AGENTS files only when a diff changes durable project intent.

## Eligibility

Edit an AGENTS file only when at least one changes:

- public module contract or dependency boundary;
- resource ownership or lifecycle responsibility;
- authoritative entry point or subsystem purpose;
- project-wide invariant;
- file addition, removal, or rename that makes routing materially inaccurate.

Ordinary commits, bug fixes, performance tuning, numeric thresholds, benchmark results, temporary workarounds, and implementation details do not qualify.

## Process

1. Read `git diff $ARGUMENTS` (`HEAD~1` by default).
2. Apply the eligibility test before reading every AGENTS file.
3. Open only the nearest affected intent node:
   - `engine/`, `renderer/`, `renderer/shaders/`, `lib/`, `types/`
   - `application/`, `context/`, `hooks/`, `components/`, `components/ui/`
   - root for project-wide configuration or changes spanning multiple subsystems
4. Replace stale guidance; do not append incident history.
5. Move shared rules to the lowest common parent and remove duplicates from children.
6. If the file would exceed roughly 600 words, consolidate or move details to dedicated documentation.
7. Report updated nodes, or state that no durable intent changed.

## Style

- Prefer short, actionable bullets.
- List only authoritative files and non-obvious invariants.
- Do not record file sizes, current counts, benchmark data, hypotheses, or one-off fixes.
- Do not run this skill merely because a commit was created.
