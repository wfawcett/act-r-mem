#!/usr/bin/env node
// watcher-ctl.mjs: status|start|stop for THIS repo's factory watcher.
// Unlike the plugin's controller, this always resolves the repo-local
// .factory/scripts/watcher.mjs first — the plugin's copy is claude-based and
// ignores factory.yml's runner/models (observed: workers died on the omp model
// role "@default"). The pid file lives next to the watcher log.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const LOG_DIR = path.join(process.env.HOME ?? "", ".claude", "factory", path.basename(REPO));
const PID_FILE = path.join(LOG_DIR, "watcher.pid");
const LOG_FILE = path.join(LOG_DIR, "watcher.log");
const WATCHER = path.join(HERE, "watcher.mjs");
const CONFIG = process.env.FACTORY_CONFIG ?? path.join(REPO, "factory.yml");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = () => {
  try {
    return Number(fs.readFileSync(PID_FILE, "utf8").trim());
  } catch {
    return null;
  }
};

const cmd = process.argv[2] ?? "status";
if (cmd === "status") {
  const pid = readPid();
  console.log(pid && alive(pid) ? `running, pid ${pid}` : "not running");
  console.log(`log: ${LOG_FILE}`);
  process.exit(0);
} else if (cmd === "stop") {
  const pid = readPid();
  if (!pid || !alive(pid)) {
    console.log("not running");
  } else {
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to pid ${pid}`);
  }
} else if (cmd === "start") {
  const pid = readPid();
  if (pid && alive(pid)) {
    console.log(`already running, pid ${pid}`);
  } else {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const out = fs.openSync(LOG_FILE, "a");
    const child = spawn(process.execPath, [WATCHER, "--config", CONFIG], { cwd: REPO, detached: true, stdio: ["ignore", out, out] });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(`started, pid ${child.pid}`);
  }
} else {
  console.error(`usage: watcher-ctl.mjs [status|start|stop]`);
  process.exit(2);
}
