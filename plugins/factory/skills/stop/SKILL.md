---
name: stop
description: Stop the factory watcher for this repo. A running phase is ended with it. Use when the user asks to stop the factory or the watcher.
---

Stop the factory watcher. Use short sentences.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/watcher-ctl.mjs" stop`.
2. Report its one line: `stopped, pid <n>` or `not running`.
3. If a card was in the middle of a phase, say that it keeps its stage and labels, and the next `factory:start` picks it up again.
