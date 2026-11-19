---
name: status
description: Show whether the factory watcher is running for this repo, and where its log is. Use when the user asks if the factory or watcher is running.
---

Show the watcher state. Use short sentences.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/watcher-ctl.mjs" status`.
2. Report `running, pid <n>` or `not running`, and the log path it prints.
3. If the person wants to know why a card has not moved, read the last lines of the log.
