---
description: Ready stage - plan the implementation from the spec
argument-hint: [card context]
---

Read the spec file for this card under `specs/` (the prompt names the issue number; if several match, take the highest). If none exists, block with the reason "no spec file".

Produce a short implementation plan as `specs/<issue-number>-plan.md`:

1. **Task list** - ordered, each item one sentence with the file(s) it touches.
2. **Types and interfaces** - the exact TypeScript signatures the new code exposes.
3. **Verification mapping** - for each task, the command from the spec's Verification section that will exercise it.
4. **Dependencies** - packages to add, if any, with the exact `npm install` line.

Do not implement anything. Do not run installers.

If extra context follows, it describes a block. Fix that problem.
