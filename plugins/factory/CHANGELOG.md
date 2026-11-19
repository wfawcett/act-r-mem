# Changelog

## 0.3.0

- Card B of #147 (#158): the skills `factory:start`, `factory:stop`, `factory:status` and `factory:inspect`, the scripts `watcher-ctl.mjs`, `watcher.mjs` and `stopped.mjs`, and `templates/factory.example.yml`.
- The watcher runs one card at a time through `run-phase.mjs`, makes one worktree per card (`.tmp/factory-worktrees/<n>` on branch `factory/<n>`), moves a card in `In review` once its closing PR is merged, and keeps no retry count. `stop` ends a running phase with the watcher.
- `inspect` runs the stage `command` in the person's own session with the block comment as optional context. A stage `command` must accept that context.
- Tests use a fake `gh`, a fake `claude` and a temp `HOME`. `tests/fake-gh.mjs` now returns `labels` per item and handles `pr list`.
- Differences from the ticket: see the PR description. The live run (AC9) and the `inspect` evals (AC7) were not run.

## 0.2.0

- Part (b) of #155: the agent `factory:factory-worker`, `phase-contract.md`, and `scripts/run-phase.mjs`. The script starts the worker with `claude -p`, reads `result.json`, and moves the card, blocks it, or counts a failed attempt (cap of 2). Tests use a fake `claude` and a fake `gh`.
- `templates/factory.yml` now has `allowed_tools` for each stage. The starter list is a floor: see the README. A `factory.yml` written by 0.1.0 needs `allowed_tools` added before `run-phase.mjs` will run a stage.
- Differences from the ticket: the result folder uses `<stage-slug>` (`In progress` gives `in-progress`) because stage names contain spaces. `recommended` goes into `--why` because `block.mjs` has no `--recommended`. A `last-reason` file next to `attempts` lets a failed block at the cap be retried with its reason.

## 0.1.0

- Initial release, part (a) of #155: the plugin skeleton, `templates/factory.yml`, the command `/factory:install`, and the board scripts `move`, `block` and `clear` with fake-`gh` tests.
- Differences from the ticket: `factory:install` is a command (`commands/install.md`), not a skill, because `strict-ts` already owns the skill name `install`. `move.mjs` takes `--from`. `setup.mjs` holds the idempotent install steps so the fake-`gh` tests can check them.
- Not in this release: the worker agent, the phase contract and `run-phase.mjs` (follow-up card), and the watcher (#158).
