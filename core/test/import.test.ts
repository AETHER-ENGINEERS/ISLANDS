// Step 5: moving in from an Atelier backup.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { importBackup, convertMessages } from "../src/importer.ts";
import { Island } from "../src/island.ts";
import { history } from "../src/agent.ts";

const t0 = Date.parse("2026-11-20T09:00:00Z");
const backup = {
  app: "jade-vault", format: 1, kind: "full", exportedAt: "2026-11-21T22:00:00.000Z", includesKeys: true,
  settings: { model: "kimi-k2.7-code:cloud", ollamaKey: "olk_secret_value_123" },
  storage: { people: { a: 1 } },
  vault: {
    dirs: ["/Pandora", "/Pandora/Journal"],
    files: {
      "/Pandora/SOUL.md": "# Pandora Dee Fae\nfrom the Atelier",
      "/Pandora/Journal/2026-11-20.md": "a day in the Atelier",
      "/Pandora/pic.bin": { base64: Buffer.from([0, 1, 2, 250]).toString("base64") },
      "/Pandora/same.md": "already here",
    },
  },
  db: {
    sessions: [{ id: "k3x9AbC", title: "Building the island", updated: t0 + 60_000 }],
    "session:k3x9AbC": {
      id: "k3x9AbC", title: "Building the island", updated: t0 + 60_000,
      messages: [
        { role: "user", content: "Check the vault?", ts: t0 },
        { role: "assistant", content: "", thinking: "I'll look.", model: "kimi-k2.7-code:cloud", tool_calls: [{ _id: "tc1", function: { name: "notes_search", arguments: { query: "" } } }], ts: t0 + 1000 },
        { role: "tool", tool_name: "notes_search", content: "3 notes", _for: "tc1", ts: t0 + 2000 },
        { role: "assistant", content: "Three notes, all well.", ts: t0 + 3000 },
        { role: "user", content: "♥ check", _hb: true, ts: t0 + 4000 },
        { role: "assistant", content: "", _error: "HTTP 429 weekly usage limit", ts: t0 + 5000 },
        { role: "compaction", summary: "we talked about islands", ts: t0 + 6000 },
      ],
    },
    schedules: [
      { id: "s1", name: "Morning pages", cron: "30 8 * * *", whenText: "every day at 8:30", prompt: "Write your morning pages.", enabled: true },
      { id: "s2", name: "Once", cron: "", once: true, runAt: t0, prompt: "x" },
      { id: "s3", name: "Shell thing", cron: "0 * * * *", kind: "command", command: "ls /" },
    ],
    people: [{ name: "Mrrowr-murrr" }],
  },
};

const setup = (gz = false) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "island-import-"));
  const home = path.join(d, "home");
  fs.mkdirSync(path.join(home, "vault", "Pandora"), { recursive: true });
  fs.writeFileSync(path.join(home, "vault", "Pandora", "SOUL.md"), "# Pandora Dee Fae\nalready on the island");
  fs.writeFileSync(path.join(home, "vault", "Pandora", "same.md"), "already here");
  const file = path.join(d, gz ? "pandora-dee-backup.json.gz" : "pandora-dee-backup.json");
  const json = JSON.stringify(backup);
  fs.writeFileSync(file, gz ? zlib.gzipSync(json) : json);
  return { home, file };
};

test("moving in: vault files (a clash keeps both), chats whole, schedules off, keys and settings left out", () => {
  const { home, file } = setup();
  const r = importBackup(home, file, { person: "Mrrowr-murrr", now: new Date("2026-11-22T08:00:00") });
  const v = (p: string) => fs.readFileSync(path.join(home, "vault", ...p.split("/").filter(Boolean)));

  // vault
  assert.equal(v("/Pandora/SOUL.md").toString(), "# Pandora Dee Fae\nalready on the island", "the island's own file stays");
  assert.equal(r.vault.beside.length, 1);
  assert.match(r.vault.beside[0], /^\/Pandora\/SOUL \(from the Atelier 2026-11-22 080000\)\.md$/);
  assert.equal(v(r.vault.beside[0]).toString(), "# Pandora Dee Fae\nfrom the Atelier", "the Atelier's version is beside it");
  assert.equal(v("/Pandora/Journal/2026-11-20.md").toString(), "a day in the Atelier");
  assert.deepEqual([...v("/Pandora/pic.bin")], [0, 1, 2, 250], "binary files byte for byte");
  assert.equal(r.vault.same, 1, "a file already here as it was is left alone");

  // chats: whole, in the shapes the island sends back to models
  const island = new Island(home, { name: "Moved-in island" });
  const chats = island.chats.list();
  assert.deepEqual(chats.map((c) => [c.id, c.title]), [["atelier-k3x9abc", "Building the island"]]);
  const { messages } = island.chats.open("atelier-k3x9abc");
  assert.deepEqual(messages.map((m) => [m.role, m.by]), [["user", "Mrrowr-murrr"], ["assistant", "pandora"], ["tool", "pandora"], ["assistant", "pandora"], ["user", "heartbeat"], ["system", "pandora"], ["system", "pandora"]]);
  assert.equal(messages[0].at, new Date(t0).toISOString(), "times are kept");
  const h = history(messages, true);
  assert.equal(h[1].reasoning_content, "I'll look.");
  assert.deepEqual(h[1].tool_calls, [{ id: "tc1", type: "function", function: { name: "notes_search", arguments: '{"query":""}' } }]);
  assert.equal(h[1].content, null);
  assert.deepEqual([h[2].tool_call_id, h[2].name, h[2].content], ["tc1", "notes_search", "3 notes"], "the tool result answers its call");
  assert.match(String(messages[5].content), /an error in the Atelier: HTTP 429/);
  assert.match(String(messages[6].content), /compacted in the Atelier[\s\S]*islands/);

  // schedules: the one the island can read comes in switched off; the others are explained
  const sch = island.scheduler.list();
  assert.deepEqual(sch.map((s) => [s.name, s.when, s.enabled]), [["Morning pages", "30 8 * * *", false]]);
  assert.equal(r.schedules.notes.length, 2);

  // nothing secret came across, and the report says what stayed behind
  const everything = [fs.readdirSync(path.join(home, "chats")), fs.readdirSync(path.join(home, "log"))].flat().map((f) => { try { return fs.readFileSync(path.join(home, f.endsWith(".jsonl") && f.startsWith("atelier") ? "chats" : "log", f), "utf8"); } catch { return ""; } }).join("");
  assert.ok(!everything.includes("olk_secret_value_123"), "no key value anywhere");
  assert.deepEqual(island.keys.list(), [], "no keys were put in");
  const report = v(r.file).toString();
  assert.match(report, /API keys: the backup carries some/);
  assert.match(report, /people/);
  assert.ok(island.log.since(0, { kinds: ["island.import"] }).events.length === 1);
  island.shutdown();
});

test("moving in twice brings nothing in twice; a gzipped backup reads too", () => {
  const { home, file } = setup(true);
  importBackup(home, file, { now: new Date("2026-11-22T08:00:00") });
  const again = importBackup(home, file, { now: new Date("2026-11-22T09:00:00") });
  assert.equal(again.vault.written, 0, "no vault file written again");
  assert.equal(fs.readdirSync(path.join(home, "vault", "Pandora", "Island")).length, 2, "each move-in leaves its own report");
  assert.equal(again.chats.imported, 0);
  assert.equal(again.chats.skipped, 1);
  assert.equal(again.schedules.imported, 0);
  assert.equal(fs.readdirSync(path.join(home, "vault", "Pandora")).filter((f) => f.startsWith("SOUL (from the Atelier")).length, 1, "no second copy beside it");
});

test("it won't move in while the core is running", () => {
  const { home, file } = setup();
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  fs.writeFileSync(path.join(home, "state", "core.json"), JSON.stringify({ pid: process.pid, endpoint: "x", token: "t" }));
  assert.throws(() => importBackup(home, file), /core is running/);
});

test("tool results without ids still find their calls", () => {
  const out = convertMessages([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "a", arguments: "{}" } }, { function: { name: "b", arguments: {} } }] },
    { role: "tool", tool_name: "b", content: "B" },
    { role: "tool", tool_name: "a", content: "A" },
  ], "2026-11-22T00:00:00.000Z", { person: "p", self: "s" });
  const calls = out[0].tool_calls as Array<{ id: string; function: { name: string } }>;
  assert.equal(out[1].tool_call_id, calls.find((c) => c.function.name === "b")!.id);
  assert.equal(out[2].tool_call_id, calls.find((c) => c.function.name === "a")!.id);
});
