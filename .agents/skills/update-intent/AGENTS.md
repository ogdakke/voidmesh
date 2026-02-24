# Update Intent Nodes

Review the git diff and update affected AGENTS.md intent nodes to reflect the current state of the code.

## Process

1. **Get the diff**: Run `git diff $ARGUMENTS` (default: `HEAD~1` if no arguments provided). Arguments can be a range like `main..HEAD` or `HEAD~5`.

2. **Identify affected nodes**: Map changed files to their intent nodes:
   - `engine/*` -> `engine/AGENTS.md`
   - `renderer/shaders/*` -> `renderer/shaders/AGENTS.md` AND `renderer/AGENTS.md`
   - `renderer/*` -> `renderer/AGENTS.md`
   - `lib/*` -> `lib/AGENTS.md`
   - `types/*` -> `types/AGENTS.md`
   - `components/ui/*` -> `components/ui/AGENTS.md`
   - `components/*` -> `components/AGENTS.md`
   - `context/*` -> `context/AGENTS.md`
   - `hooks/*` -> `hooks/AGENTS.md`
   - `package.json`, `tsconfig.json`, `vite.config.ts`, `app.tsx` -> `AGENTS.md` (root)
   - Changes spanning 3+ subsystems -> also check root `AGENTS.md`

3. **For each affected node**, read the current AGENTS.md and the changed files, then check if any of these sections need updating:
   - **Key files list** (new files added, files removed or renamed, size changes)
   - **Patterns** (new patterns introduced by the changes)
   - **Anti-patterns** (new pitfalls discovered)
   - **Dependencies** (new cross-subsystem imports)
   - **Architecture descriptions** (significant refactors)

4. **LCA check**: Before writing, verify you are not duplicating information that belongs at a parent node. If the same knowledge applies to multiple siblings, move it to the parent.

5. **Check opensrc section**: If changes added, removed, or updated dependencies (check `package.json` diff), verify the `opensrc/` directory still reflects the project's dependencies. If a new dependency was added and its source would be useful, note it in the summary. If a dependency was removed and its `opensrc/` source is now stale, note that too.

6. **Apply updates**: Edit only the affected AGENTS.md files. Keep the existing style consistent (sections: Purpose, Key files, Patterns, Anti-patterns, Dependencies).

7. **Summary**: For each updated node, briefly state what changed and why. Include any opensrc staleness notes.

## Style Rules

- Be concise and dense. Favor bullet points over prose.
- Include file sizes only for large files (>10KB).
- List concrete file names, not vague descriptions.
- Patterns and anti-patterns should be actionable ("Do X", "Do not Y").
- Do not duplicate information that exists in a parent AGENTS.md.
