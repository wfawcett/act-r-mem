import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { ROOT } from "./helpers.mjs";

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// AC1 (local part)
test("plugin.json is 0.3.0 and depends only on atlassian-worker", () => {
  const p = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(p.version, "0.3.0");
  assert.deepEqual(p.dependencies, ["atlassian-worker"]);
  assert.deepEqual(Object.keys(p).sort(), ["author", "dependencies", "description", "name", "version"]);
});

test("CHANGELOG has a 0.2.0 entry", () => {
  assert.match(read("CHANGELOG.md"), /^## 0\.2\.0$/m);
});

test("the stage parent delegates via task tool and never does stage work itself", () => {
  const text = read("agents/factory-worker.md");
  // The omp parent contract is a bare file (no frontmatter): run-phase passes it
  // through --system-prompt, so identity comes from the assignment, not YAML.
  assert.ok(!/^---/.test(text), "parent contract must not carry frontmatter");
  assert.match(text, /delegate the assignment .* to the named agent via the `task`/);
  assert.match(text, /never do stage work/i);
});

test("phase-contract.md exists and names the three statuses", () => {
  const text = read("phase-contract.md");
  for (const s of ["done", "blocked", "failed"]) assert.ok(text.includes(`\`${s}\``));
});

test("the template gives every command an allowed_tools list", () => {
  const { commands } = parseYaml(read("templates/factory.yml"));
  assert.ok(Object.keys(commands).length > 0);
  for (const [stage, c] of Object.entries(commands)) {
    assert.ok(Array.isArray(c.allowed_tools) && c.allowed_tools.length > 0, `${stage} has no allowed_tools`);
  }
});
