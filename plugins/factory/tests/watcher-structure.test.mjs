import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { ROOT } from "./helpers.mjs";

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel));
    else out.push(rel);
  }
  return out;
}

// AC8: the patterns are built from fragments so this file does not match itself.
// The dangerous Claude flag is named only as fragments below (never the joined
// string), so this file stays clean under its own scan. "--auto-approve" is NOT
// forbidden: it is omp's headless consent flag, required by run-phase.
const FORBIDDEN = [
  ["engineering", "design"].join("-"),
  ["engineering", "build"].join("-"),
  ["dangerously", "skip", "permissions"].join("-"),
  ["gh", "pr", "merge"].join(" "),
];

test("scripts, skills, commands, agents and tests name no design or build plugin and never skip permissions or merge", () => {
  for (const dir of ["scripts", "skills", "commands", "agents", "tests"]) {
    for (const f of files(dir)) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const word of FORBIDDEN) assert.ok(!text.includes(word), `${f} contains "${word}"`);
    }
  }
});

test("each new skill has name and description", () => {
  for (const name of ["start", "stop", "status", "inspect"]) {
    const front = read(`skills/${name}/SKILL.md`).match(/^---\n([\s\S]*?)\n---\n/)[1];
    assert.match(front, new RegExp(`^name: ${name}$`, "m"));
    assert.match(front, /^description: .+/m);
  }
});

test("the example file has the template's keys and three real commands", () => {
  const template = parseYaml(read("templates/factory.yml"));
  const example = parseYaml(read("templates/factory.example.yml"));
  assert.deepEqual(Object.keys(example), Object.keys(template));
  assert.deepEqual(Object.keys(example.commands), ["Specify", "Ready", "In progress"]);
  for (const [stage, c] of Object.entries(example.commands)) {
    assert.ok(typeof c.command === "string" && c.command.length > 0, `${stage} has no command`);
    assert.ok(Array.isArray(c.allowed_tools) && c.allowed_tools.length > 0, `${stage} has no allowed_tools`);
    assert.ok(c.command.includes("If extra context follows"), `${stage} does not accept block context`);
  }
});

test("plugin.json is 0.3.0 with the same keys and CHANGELOG has the entry", () => {
  const p = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(p.version, "0.3.0");
  assert.deepEqual(p.dependencies, ["atlassian-worker"]);
  assert.deepEqual(Object.keys(p).sort(), ["author", "dependencies", "description", "name", "version"]);
  assert.match(read("CHANGELOG.md"), /^## 0\.3\.0$/m);
});
