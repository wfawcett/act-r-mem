---
description: In progress stage - implement the plan
argument-hint: [card context]
---

Read the plan file for this card under `specs/` (the prompt names the issue number; if several match, take the highest). If none exists, block with "no plan file".

Implement every task in the plan's task list. For each task:

1. Make the change with the smallest diff that satisfies it.
2. Run `npm run strict-ts-quick -- --touched <files>` after edits when `package.json` has the script; skip silently if not wired yet.
3. Commit with a message describing the task.

When all tasks are done, run the plan's Verification command end to end. If it fails, fix and rerun until it passes (max 3 fix attempts, then write `blocked` with the failing output).

Push the branch `factory/<issue-number>` to `origin` and open a PR with body containing `Closes #<issue-number>`. The PR must not be merged; leave it open. Write `result.json` with status `done`.

If extra context follows, it describes a block. Fix that problem.
