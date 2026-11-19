# act-r-mem

ACT-R memory models. TypeScript implementation of ACT-R declarative memory (activations, base-level learning, spread, retrieval).

Review-time rules: see `CODING_STANDARDS.md` — comments describe actual behavior, no unscoped devDeps in workspaces.

## Factory: waiting for the board

The watcher (`.factory/scripts/watcher.mjs`) owns the board. Never run it, stop it, or
replace it with manual polling from the main thread. When you must wait for a board event,
plant `.factory/scripts/monitor.mjs` as one background job and block on it:

```
node .factory/scripts/monitor.mjs &   # exits 0 with GATE/BLOCK/PR EVENT when a person is needed
wait $!
```

Never `sleep N && check` in a loop — that pattern burned ~40 h of the 2026-11-17 factory
run and tripped the tool-call-loop detector 6 times. One monitor, one `wait`, act on the
single event it prints.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `wfawcett/act-r-mem`, operated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` at the repo root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
