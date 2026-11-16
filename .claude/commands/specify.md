---
description: Specify stage - write the spec for the card
argument-hint: [card context]
---

Write a short implementation spec for the card described in the prompt. Read the repo first: `README.md`, `factory.yml`, the source tree, and any existing ticket the prompt references.

The spec must cover, in this order:

1. **Goal** - one sentence describing the observable behavior when done.
2. **Approach** - the files to create or change and the key symbols/types involved. Concrete, no alternatives.
3. **Verification** - the exact command that proves the behavior (a test, a build, a script run) and what output proves it.
4. **Out of scope** - anything explicitly not part of this card.

Write the spec to `specs/<issue-number>-<slug>.md` in the repo root. Keep it under 60 lines. Do not implement anything.

If extra context follows, it describes a block. Fix that problem.
