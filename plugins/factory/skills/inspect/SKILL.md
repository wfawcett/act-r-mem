---
name: inspect
description: List the factory cards that are stopped on BLOCKED or REVIEW, or fix and clear one. Runs in the person's own session. Use when the user asks what is blocked, or to clear or inspect a stopped card. Argument is a card number.
---

Help a person clear a stopped card. Use short sentences and plain words. Scripts are not on PATH. Run them as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"`. They read `factory.yml` from the current directory, or from `FACTORY_CONFIG`.

## No argument

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/stopped.mjs"` and show its output. Each line is `#<n> <stage> <label> need: <text> why: <text>`. No output means no card is stopped. Say so.

## With a card number

1. Run `stopped.mjs` and find the line for that card. If there is none, say the card is not stopped and stop.
2. Read the block comment: `gh issue view <n> --repo <board.repo> --json comments`. Take the latest comment whose first line is `factory: BLOCKED` or `factory: REVIEW`.

### BLOCKED

1. Explain the stop in plain words: what a person must do (`need`) and why (`why`).
2. Find the stage's `command` in `factory.yml` under `commands`. If the stage has no `command`, explain that and stop.
3. Run that `command` in this session, as prompt text through the Skill tool. Add the block comment after it as optional context. The command fixes the problem the comment describes.
4. When the command has ended and the problem is fixed, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/clear.mjs" <n> --solution "<one paragraph>"`.
5. Never run `clear.mjs` when the command did not finish, failed, or the person stopped it. Say the card stays blocked.

### REVIEW

1. Show the reason.
2. The person chooses. To approve, run `clear.mjs <n> --label REVIEW --solution "<text>"`. To send the card back, run `block.mjs <n> --need "<text>" --why "<text>"`.
3. Do nothing until the person chooses.
