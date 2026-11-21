#!/usr/bin/env node
// Run the island's core in a console (the harbor runs it as a service later):
//
//   node core/bin/island.ts <home> [--name <name>]
//   ISLAND_HOME=<home> node core/bin/island.ts
//
// It keeps running until Ctrl+C. Ferries find it through <home>/state/core.json.

import fs from "node:fs";
import path from "node:path";
import { Island } from "../src/island.ts";
import { listen } from "../src/server.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const name = flag("--name") ?? process.env.ISLAND_NAME ?? "island";
const home = args[0] ?? process.env.ISLAND_HOME;
if (!home) {
  console.error("usage: node core/bin/island.ts <home> [--name <name>]   (or set ISLAND_HOME)");
  process.exit(2);
}

// one core per home: two would both count the log and both answer for her
try {
  const was = JSON.parse(fs.readFileSync(path.join(home, "state", "core.json"), "utf8"));
  if (was.pid && was.pid !== process.pid) {
    let alive = false;
    try { process.kill(was.pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
    if (alive) {
      console.error(`A core is already running for this home (pid ${was.pid}). Only one may.`);
      process.exit(1);
    }
  }
} catch {}

const island = new Island(home, { name });
const door = await listen(island);
island.log.append({ actor: "island", via: "core", kind: "island.start", version: process.version, pid: process.pid });
island.scheduler.start();
console.log(`${name} is up. Home: ${island.dirs.home}. Door: ${door.endpoint}. Last event: ${island.log.last}.`);

let stopping = false;
const stop = async (why: string) => {
  if (stopping) return;
  stopping = true;
  island.log.append({ actor: "island", via: "core", kind: "island.stop", why });
  await door.close();
  island.shutdown();
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
// the harbor asks it to stop by closing its stdin
if (process.env.ISLAND_STOP_ON_STDIN_END) process.stdin.on("end", () => void stop("harbor")).resume();
