# Phase contract

How one stage of one card runs, and what the factory does with the outcome. The caller (the watcher) runs:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-phase.mjs" <issue> <stage> --cwd <worktree> [--config <path>]
```

The caller creates the worktree and reuses one worktree per card across polls. `run-phase.mjs` is a thin launcher: it starts `claude -p --agent factory:factory-worker` in `--cwd`, reads `result.json` and acts on it. It reads `factory.yml` from `--config`, else `FACTORY_CONFIG`, else `./factory.yml`.

## result.json

Path: `<worktree>/.tmp/factory/<issue>/<stage-slug>/result.json`. The stage slug is the stage name in lower case, each run of non-alphanumeric characters turned into `-` (`In progress` gives `in-progress`). The prompt gives the worker the exact absolute path.

| Field | Meaning |
|---|---|
| `status` | `done`, `blocked` or `failed`. |
| `need` | What a person must do. Required and non-empty for `blocked`. On `failed`, if present, the failure reason. |
| `recommended` | The suggested answer. Optional. |
| `artifacts` | Paths or links the phase produced. Optional. |

## What run-phase.mjs does

| Status | Action | stdout starts with |
|---|---|---|
| `done` | `move.mjs <issue> <next stage> --from <stage>`. The next stage is the next entry of `stages`. The attempt count clears only after `move.mjs` exits 0. | `done` |
| `blocked` | `block.mjs <issue> --need <need> --why "<stage> phase blocked. Recommended: <recommended or none>"`. The card keeps its stage. The count clears only after `block.mjs` exits 0. | `blocked` |
| `failed` or any invalid outcome | Adds 1 to the attempt count. Under the cap of 2: nothing else. At the cap: `block.mjs` with the last reason and the path of `claude.log`; the count clears only after `block.mjs` exits 0. If `block.mjs` fails, the count stays at the cap and the next call tries `block.mjs` again without starting `claude`. | `retry` under the cap, `blocked` at the cap |

Invalid outcomes count as `failed`: `claude` exits non-zero (even if `result.json` says `done`), `result.json` is missing, it is not valid JSON, `status` is unknown, or `status` is `blocked` with an empty `need`. The old `result.json` is deleted before each run, so a stale file is never read.

`need`, `recommended` and the reason are passed with each run of whitespace turned into one space.

The attempt count is a file `attempts` (one integer) next to `result.json`. A missing or non-integer file reads as 0. A file `last-reason` beside it holds the last failure reason, so a failed block at the cap can be retried with its reason; both files clear together. A person who clears a block gives the stage two fresh attempts.

## Exit codes

- `0`: `done`, `blocked` or `retry`.
- `3`: `move.mjs` found the card moved by a person. Nothing changes. stdout starts `moved`.
- `2`: usage error. Nothing starts and the board is unchanged: missing or non-directory `--cwd`, unknown or last stage, or a stage without `command`, `model`, `max_turns` or a non-empty `allowed_tools` in `factory.yml`.
- `1`: any other failure, including a failed `move.mjs` or `block.mjs`. stdout starts `error`.
