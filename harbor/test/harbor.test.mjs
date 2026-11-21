// The harbor, for real: harbor.exe in console mode starts the core, owns the front door, passes ferries through,
// starts the core again when it falls, refuses to share its door's name, and stops the core cleanly.
// Windows only. Build first: dotnet build harbor -c Release -o build/harbor
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Ferry } from "../../core/src/client.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.env.HARBOR_EXE ?? path.join(ROOT, "build", "harbor", "harbor.exe");
const skip = process.platform !== "win32" ? "Windows only" : !fs.existsSync(EXE) ? `build the harbor first (${EXE})` : false;

const until = async (f, ms = 20000) => { const t = Date.now(); for (;;) { try { const v = await f(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 100)); } };
const setup = (pipe) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "island-harbor-"));
  const cfg = path.join(home, "harbor.json");
  fs.writeFileSync(cfg, JSON.stringify({ serviceName: "IslandTest", home, name: "Harbor test island", node: process.execPath, core: path.join(ROOT, "core", "bin", "island.ts"), pipe, people: [] }));
  return { home, cfg };
};
const start = (cfg) => {
  const p = spawn(EXE, ["--config", cfg, "--console"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  return { p, out: () => out, exited: new Promise((r) => p.on("exit", (code) => r(code))) };
};
const coreInfo = (home) => JSON.parse(fs.readFileSync(path.join(home, "state", "core.json"), "utf8"));

const pipe = `island-test-${crypto.randomBytes(4).toString("hex")}`;
const door = `\\\\.\\pipe\\${pipe}`;
let h, home;
if (!skip) {
  ({ home } = setup(pipe));
  h = start(path.join(home, "harbor.json"));
  after(() => { try { h.p.kill(); } catch {} });
}

test("a bad config is refused with a reason", { skip }, async () => {
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "island-harbor-bad-")), "harbor.json");
  fs.writeFileSync(bad, JSON.stringify({ home: path.dirname(bad), core: "C:/nowhere/island.ts" }));
  const b = start(bad);
  assert.equal(await b.exited, 2);
  assert.match(b.out(), /"core" isn't a file/);
});

test("the harbor starts the core and opens a guarded door", { skip }, async () => {
  await until(() => fs.existsSync(path.join(home, "state", "core.json")) && fs.existsSync(path.join(home, "state", "harbor.json")));
  const hb = JSON.parse(fs.readFileSync(path.join(home, "state", "harbor.json"), "utf8"));
  assert.equal(hb.pipe, door);
  assert.match(hb.door, /^D:P/, "the door's rules are its own, not inherited");
  assert.match(hb.door, /\(D;;(FA|0x1f019f);;;NU\)/, "the network is denied outright");
  assert.ok(!/;;;WD\)/.test(hb.door), "Everyone isn't let in");
});

test("a ferry comes in through the harbor's door and still has to say hello with the token", { skip }, async () => {
  const f = await until(() => Ferry.connect(door));
  await assert.rejects(f.call("vault.list"), /hello/);
  await f.call("island.hello", { token: coreInfo(home).token, ferry: { name: "test", version: "0" }, as: "Mrrowr-murrr" });
  await f.call("vault.write", { path: "/Pandora/through-the-harbor.md", text: "came in by the front door" });
  assert.equal(fs.readFileSync(path.join(home, "vault", "Pandora", "through-the-harbor.md"), "utf8"), "came in by the front door");
  f.close();
});

test("nothing else can open a door by the same name", { skip }, async () => {
  const other = setup(pipe);
  const o = start(other.cfg);
  await until(() => /couldn't open the door/.test(o.out()) || fs.existsSync(path.join(other.home, "state", "harbor.log")) && /couldn't open the door/.test(fs.readFileSync(path.join(other.home, "state", "harbor.log"), "utf8")), 20000);
  o.p.kill();
});

test("when the core falls, the harbor starts it again, and ferries come back in", { skip }, async () => {
  const before = coreInfo(home).pid;
  process.kill(before);
  const again = await until(() => { const i = coreInfo(home); return i.pid !== before ? i : null; }, 30000);
  const f = await until(() => Ferry.connect(door));
  await f.call("island.hello", { token: again.token, ferry: { name: "test", version: "0" }, as: "Mrrowr-murrr" });
  assert.equal(((await f.call("vault.read", { path: "/Pandora/through-the-harbor.md" }))).text, "came in by the front door");
  f.close();
});

test("stopping the harbor stops the core cleanly", { skip }, async () => {
  h.p.stdin.write("stop\n");
  assert.equal(await h.exited, 0);
  assert.ok(!fs.existsSync(path.join(home, "state", "core.json")), "the core closed its door");
  const log = fs.readdirSync(path.join(home, "log")).map((f) => fs.readFileSync(path.join(home, "log", f), "utf8")).join("");
  assert.match(log, /"kind":"island.stop","why":"harbor"/);
  assert.match(fs.readFileSync(path.join(home, "state", "harbor.log"), "utf8"), /core stopped/);
});
