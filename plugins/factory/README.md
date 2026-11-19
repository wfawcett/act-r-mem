# factory

Board mechanics for a team's own stage method. The plugin moves cards on a GitHub Project, stops them with a label and keeps an audit comment. It holds no stage logic. The team picks the `command` for each stage in `factory.yml`.

A card stops with a label, not a column. `BLOCKED` means a person must act. `REVIEW` means a person must look and nothing is wrong. The card keeps its stage.

Running a phase is `scripts/run-phase.mjs` with the `factory:factory-worker` agent, described in `phase-contract.md`. The watcher (`factory:start`) calls it for you: see "Running the board".

## Running the board

Run these from the repo that holds `factory.yml` (or set `FACTORY_CONFIG`). Stop the old `scripts/factory-watch.sh` watcher before `factory:start`.

| Skill | Does |
|---|---|
| `factory:start` | Starts the watcher in the background. A bad or missing `factory.yml` exits 2 and starts nothing. A second `start` prints the live pid and starts nothing. |
| `factory:stop` | Stops the watcher and any phase it is running. The card keeps its stage and labels. The next `start` picks it up. |
| `factory:status` | Prints `running, pid <n>` or `not running`, and the log path. |
| `factory:inspect [number]` | No argument: lists the cards that have `BLOCKED` or `REVIEW`, with stage and reason. With a number: explains the stop, runs the stage `command` in your own session with the block comment as optional context, then clears the label. |

State lives under `~/.claude/factory/<repo>/`, where `<repo>` is the REPO part of `board.repo`: `watcher.pid` and `watcher.log`.

The watcher works ONE card at a time, in board order. It skips Backlog, Done, stages with no `command`, and cards with `BLOCKED` or `REVIEW`. For each card it makes one worktree, `.tmp/factory-worktrees/<n>` on branch `factory/<n>`, and reuses it. The stage `command` renames the branch before the first push. The watcher keeps no retry count: `run-phase.mjs` owns the cap of 2. It polls again at once only after `run-phase.mjs` exits 0 or 3, and sleeps `poll_seconds` otherwise. Known limit: a card whose phase keeps exiting 1 or 2 (for example a missing `allowed_tools`) stays first in board order and holds up the cards behind it until the config is fixed. When the PR that closes a card in `In review` is merged (the PR body says `Closes #<n>`), the watcher moves the card to `Approved` if that stage has a `command`, else `Done`, and clears `REVIEW`. The watcher never merges.

A stage `command` must accept the block comment as optional context and fix the problem it describes. `inspect` appends the comment to the command. Each example command ends with "If extra context follows, it describes a block. Fix that problem."

`templates/factory.example.yml` is a copy of the template with the three commands filled in and a wider `allowed_tools`. `factory:install` never overwrites your `factory.yml`: copy the commands by hand.

## Set up

1. Enable `factory` in `.claude/settings.json` by hand. The plugin never edits `.claude/settings.json`.
2. Run `/factory:install`. It shows a plan, asks once for consent, then creates the Project stages, the `BLOCKED` and `REVIEW` labels, `factory.yml` and the `.tmp/*` ignore line. It ends with a dummy card test. A second run changes nothing.

`gh` needs the `project` scope: `gh auth refresh -s project`.

## Scripts

Scripts are not on PATH. Run them as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"`. They read `factory.yml` from the current directory, or from `FACTORY_CONFIG`.

| Script | Does |
|---|---|
| `move.mjs <issue> <stage> --from <stage> --reason <text>` | Reads the card's column again. If it is not `--from`, exits non-zero and changes nothing. Otherwise moves it and writes one audit comment (from, to, reason, time). |
| `block.mjs <issue> --need <text> --why <text> [--label BLOCKED\|REVIEW]` | Adds the label and writes one comment. A repeat for the same state writes no second comment. |
| `clear.mjs <issue> --solution <text> [--label BLOCKED\|REVIEW]` | Removes the label and writes one comment with the solution. |
| `run-phase.mjs <issue> <stage> --cwd <worktree> [--config <path>]` | Runs one attempt of a stage: starts the worker through `claude -p`, reads `result.json`, then moves the card, blocks it or counts a failed attempt. Prints `done`, `blocked` or `retry`. See `phase-contract.md`. |
| `setup.mjs labels\|ignore\|config` | Idempotent steps used by `/factory:install`. |

Each comment starts with a first line the scripts use to find their earlier comment, for example `factory: BLOCKED`.

## factory.yml

See `templates/factory.yml`. It holds the board ids, the ordered `stages`, the `labels`, one `command` per stage with `model` and `max_turns`, `poll_seconds` and `merge.auto` (default `false`). The file uses a small YAML subset: nested maps, lists and plain scalars, no inline comments.

Example commands per stage (the plugin names none of them): a spec command for `Specify`, a design command for `Ready`, a build command for `In progress`.

## Running a phase

`run-phase.mjs` runs `claude -p --agent factory:factory-worker --permission-mode acceptEdits` in the worktree the caller made, with `--model` and `--max-turns` from the stage's entry in `factory.yml`. The stage's `command` is prompt text the worker runs through the Skill tool, for example a slash command. It is not a shell command. The plugin never passes a flag that skips permission checks.

Each stage under `commands` needs `command`, `model`, `max_turns` and a non-empty `allowed_tools` list. A `factory.yml` written by 0.1.0 has no `allowed_tools`: add it, or `run-phase.mjs` refuses to run that stage.

- The starter `allowed_tools` (`Skill`, `Read`, `Glob`, `Grep`, `Bash(git *)`) is only a floor. In `-p` mode a tool outside the list (for example `gh`, `node`, `npm test` or an MCP tool) is denied, so a real stage command fails. The phase then ends `failed`, and after 2 attempts the card is `BLOCKED` with the reason in `claude.log`. `acceptEdits` covers file edits in the worktree only. Add what your stage commands need.
- `--agent factory:factory-worker` resolves only if the worktree's committed `.claude/settings.json` enables `factory`. Otherwise `claude` exits 1 and the phase is `failed`.
- The caller reuses one worktree per card, because the attempt count lives in it.

## Tests

```
node --test plugins/factory/tests/*.test.mjs
```

The tests use a fake `gh`. They never touch a real board. CI does not run them. The install evals in `evals/install/evals.json` need a live `claude` and run locally.
