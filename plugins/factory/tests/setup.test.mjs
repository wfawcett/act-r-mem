import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { makeEnv, OPTIONS, ROOT } from "./helpers.mjs";

const TEMPLATE = path.join(ROOT, "templates", "factory.yml");

// AC3
test("config: writes factory.yml with the live ids and every stage", () => {
  const e = makeEnv();
  const r = e.writeConfig();
  assert.equal(r.status, 0, r.stderr);
  const cfg = parseYaml(fs.readFileSync(e.config, "utf8"));
  assert.equal(cfg.board.repo, "acme/widgets");
  assert.equal(cfg.board.owner, "acme");
  assert.equal(cfg.board.project_number, 3);
  assert.equal(cfg.board.project_id, "PVT_1");
  assert.equal(cfg.board.field_id, "F1");
  assert.deepEqual(cfg.board.options, OPTIONS);
  assert.deepEqual(cfg.stages, Object.keys(OPTIONS));
  assert.deepEqual(cfg.labels, ["BLOCKED", "REVIEW"]);
  assert.equal(cfg.merge.auto, false);
  assert.equal(cfg.poll_seconds, 300);
});

test("template: parses, and each command has model and max_turns", () => {
  const cfg = parseYaml(fs.readFileSync(TEMPLATE, "utf8"));
  assert.deepEqual(cfg.stages, Object.keys(cfg.board.options));
  for (const [stage, c] of Object.entries(cfg.commands)) {
    assert.ok(cfg.stages.includes(stage), stage);
    assert.ok("command" in c && c.model && Number.isInteger(c.max_turns), stage);
  }
  assert.equal(cfg.merge.auto, false);
});

test("template: holds no script path", () => {
  assert.ok(!/\.mjs|scripts\//.test(fs.readFileSync(TEMPLATE, "utf8")));
});

// AC4
test("config: a second run leaves factory.yml unchanged", () => {
  const e = makeEnv();
  e.writeConfig();
  const before = fs.readFileSync(e.config, "utf8");
  const r = e.writeConfig();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /left unchanged/);
  assert.equal(fs.readFileSync(e.config, "utf8"), before);
});

test("labels: creates BLOCKED and REVIEW once, a second run creates none", () => {
  const e = makeEnv();
  assert.equal(e.script("setup", "labels", "--repo", "acme/widgets").status, 0);
  assert.deepEqual(e.read().repoLabels, ["BLOCKED", "REVIEW"]);
  const created = () => e.read().calls.filter((c) => c[0] === "label" && c[1] === "create").length;
  assert.equal(created(), 2);
  e.script("setup", "labels", "--repo", "acme/widgets");
  assert.equal(created(), 2);
});

test("labels: only the missing label is created", () => {
  const e = makeEnv({ repoLabels: ["BLOCKED"] });
  e.script("setup", "labels", "--repo", "acme/widgets");
  assert.deepEqual(e.read().repoLabels, ["BLOCKED", "REVIEW"]);
});

test("ignore: adds .tmp/* once, with or without a trailing newline", () => {
  const e = makeEnv();
  const f = path.join(e.dir, ".gitignore");
  fs.writeFileSync(f, "node_modules");
  e.script("setup", "ignore");
  e.script("setup", "ignore");
  assert.equal(fs.readFileSync(f, "utf8"), "node_modules\n.tmp/*\n");
});

test("ignore: creates .gitignore when it is missing", () => {
  const e = makeEnv();
  e.script("setup", "ignore");
  assert.equal(fs.readFileSync(path.join(e.dir, ".gitignore"), "utf8"), ".tmp/*\n");
});

test("setup: unknown step and missing flags exit 2", () => {
  const e = makeEnv();
  assert.equal(e.script("setup", "nope").status, 2);
  assert.equal(e.script("setup", "config", "--repo", "a/b").status, 2);
});

// AC2 structure
test("install command exists as a command, not a skill", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "commands", "install.md")));
  assert.ok(!fs.existsSync(path.join(ROOT, "skills", "install")));
});

test("install command asks for consent and never edits settings or makes a token", () => {
  const text = fs.readFileSync(path.join(ROOT, "commands", "install.md"), "utf8");
  assert.match(text, /Apply this plan\?/);
  assert.match(text, /gh auth refresh -s project/);
  assert.match(text, /Never create a token/);
  assert.ok(!/--dangerous(?:ly)-skip-permissions/.test(text));
});

test("evals.json parses, has unique ids and complete evals", () => {
  const { skill_name, evals } = JSON.parse(fs.readFileSync(path.join(ROOT, "evals", "install", "evals.json"), "utf8"));
  assert.equal(skill_name, "install");
  assert.ok(evals.length >= 2);
  assert.equal(new Set(evals.map((x) => x.id)).size, evals.length);
  for (const x of evals) {
    assert.ok(x.prompt && x.expected_output && x.expectations.length > 0);
  }
  const text = JSON.stringify(evals);
  assert.ok(text.includes("AC2") && text.includes("AC4"));
});

test("plugin.json lists only atlassian-worker", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(m.name, "factory");
  assert.deepEqual(m.dependencies, ["atlassian-worker"]);
  assert.ok(m.description && m.author);
});
