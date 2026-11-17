# Coding standards

Review-time rules for this repo. Violations show up as review findings, not build failures.

## Comments must describe actual behavior

A comment that restates the code, narrates history ("now we…", "changed to…"), or describes
behavior the code does not have is a defect. Comments state invariants, reasons, and
non-obvious constraints — in the present tense, about the code as it is now.

Examples:
- Bad: `// increment the counter` above `count += 1;`
- Bad: `// TODO: make this robust` left in merged code
- Good: `// psql :'var' params don't expand inside -tAc, so escape quotes JS-side.`

## No unscoped devDependencies in workspaces

Workspace packages (`packages/*`, `apps/*`) declare only the devDependencies they use.
Shared tooling (typescript, vitest, eslint, globals) lives in the workspace root
`package.json` once — never duplicated per package. `pnpm add -D -w` is the way; a bare
`pnpm add -D` inside a package that duplicates root tooling is a review finding.

## Factory scripts (.factory/)

- Plain Node `.mjs`. Covered by `pnpm lint` (node globals configured in `eslint.config.mjs`).
- Every script change must keep `node --check` clean; CI enforces both.
- Board-mutating scripts (`move`, `block`, `clear`) must stay idempotent — a repeated run
  writes no duplicate comments.
