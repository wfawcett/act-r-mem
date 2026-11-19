---
name: start
description: Start the factory watcher for this repo. It runs in the background and works the board one card at a time. Use when the user asks to start the factory or the watcher.
---

Start the factory watcher. Use short sentences.

1. Check that `factory.yml` is in the current directory (or `FACTORY_CONFIG` names it).
2. Tell the person to stop the old `scripts/factory-watch.sh` watcher first, if they ran it.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/watcher-ctl.mjs" start`.
4. Report its one line: `started, pid <n>` or `already running, pid <n>`. A bad or missing `factory.yml` exits 2 and starts nothing: show the message.
5. Tell the person where the log is: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/watcher-ctl.mjs" status`.

The watcher uses the person's own `claude` and `gh` sign-ins. It never merges a PR.
