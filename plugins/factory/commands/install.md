---
description: Set up the factory in this repo - a GitHub Project with the stages, the BLOCKED and REVIEW labels, factory.yml and a dummy card test. Shows the plan first and changes nothing without consent.
argument-hint: [owner/repo]
---

Set up the factory for this repo. Use short sentences and active voice. Ask one question at a time, each with a recommended answer.

Scripts are not on PATH. Run them as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"`. The template is `${CLAUDE_PLUGIN_ROOT}/templates/factory.yml`.

Never create a token. Never run `rm -rf`. Never touch the live `POC Marketplace Factory` board: use a scratch Project for tests. Never edit `.claude/settings.json` and never check which plugins are enabled.

## 1. Check (read-only)

1. Run `gh auth status`. If the `project` scope is missing, tell the person to run `gh auth refresh -s project` and stop.
2. Find the repo (`$ARGUMENTS`, or `gh repo view --json nameWithOwner`) and its owner.
3. Look at what exists. Does `factory.yml` exist in the repo root? Which Projects does the owner have (`gh project list --owner <owner>`)? Do the `BLOCKED` and `REVIEW` labels exist (`gh label list`)? Does `.gitignore` hold `.tmp/*`?
4. Report the state of GitHub's built-in project rules (for example "item closed: set Done"). They can race with the factory. Report only. Do not change them.

## 2. Ask

Ask one question at a time, each with a recommended answer:

- Create a new Project, or use an existing one? Recommended: create a new one named `Factory`.
- Which field holds the stages? Recommended: `Status`. If the `Status` options cannot be replaced (see step 4), use a new field named `Stage`.

## 3. Show the plan and ask for consent once

List every change you will make: Project to create or reuse, the field and its stage options (read the `stages` list in the template), the two labels, `factory.yml`, the `.tmp/*` line, and the dummy card test. Mark each item that already exists as "no change".

Ask once: "Apply this plan?" If the answer is not a clear yes, change nothing and stop.

## 4. Apply (only after consent)

Skip any step that is already done. A second run changes nothing.

1. Project: `gh project create --owner <owner> --title <title>` (or reuse). Link it with `gh project link <number> --owner <owner> --repo <repo>`.
2. Stage options:
   - Read the field with `gh project field-list <number> --owner <owner> --format json`.
   - For `Status`, replace the options with `gh api graphql` and the `updateProjectV2Field` mutation. No `gh project` command edits an existing field's options.
   - If the mutation fails, create a field named `Stage` with `gh project field-create <number> --owner <owner> --name Stage --data-type SINGLE_SELECT --single-select-options "<stage 1>,<stage 2>,..."`.
   - Read the field again to get the field id and one option id per stage.
3. Labels: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" labels --repo <repo>`
4. Ignore line: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" ignore`
5. Config: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" config --repo <repo> --owner <owner> --number <n> --project-id <id> --field-name <Status|Stage> --field-id <id> --options "Backlog=<id>,Specify=<id>,..."`. It never overwrites an existing `factory.yml`.

## 5. Dummy card test

1. Create an issue titled `factory install test`. Add it to the Project and put it in the first stage.
2. Move it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/move.mjs" <issue> <second stage> --from <first stage> --reason "install test"`
3. Block it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/block.mjs" <issue> --need "none" --why "install test"`
4. Clear it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/clear.mjs" <issue> --solution "install test"`
5. Close the issue.
6. Report each result. If a step fails, say which one and stop.

## 6. Summary

Print what changed, what was already in place, and the next step: set a `command` for each stage in `factory.yml`.
