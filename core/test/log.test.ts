import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/log.ts";
import { Chats } from "../src/chats.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "island-log-"));

test("seq counts up, survives a restart, and the log replays from any point", () => {
  const d = tmp();
  const a = new EventLog(d);
  for (let i = 0; i < 5; i++) a.append({ actor: "pandora", kind: i % 2 ? "vault.write" : "chat.message", i });
  const b = new EventLog(d);
  assert.equal(b.last, 5);
  assert.equal(b.append({ actor: "pandora", kind: "vault.write" }).seq, 6);
  assert.deepEqual(b.since(3).events.map((e) => e.seq), [4, 5, 6]);
  assert.deepEqual(b.since(0, { kinds: ["vault."] }).events.map((e) => e.seq), [2, 4, 6]);
  const page = b.since(0, { limit: 2 });
  assert.deepEqual([page.events.map((e) => e.seq), page.more], [[1, 2], true]);
});

test("segments roll over and still read as one log", () => {
  const d = tmp();
  const a = new EventLog(d, { maxSegment: 300 });
  for (let i = 0; i < 20; i++) a.append({ actor: "pandora", kind: "vault.write", subject: `/n/${i}.md` });
  assert.ok(fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).length > 3);
  const b = new EventLog(d, { maxSegment: 300 });
  assert.equal(b.last, 20);
  assert.deepEqual(b.since(0).events.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("a line cut short by a crash is set aside, and the log goes on", () => {
  const d = tmp();
  const a = new EventLog(d);
  a.append({ actor: "pandora", kind: "a" });
  a.append({ actor: "pandora", kind: "b" });
  fs.appendFileSync(path.join(d, "00000001.jsonl"), '{"seq":3,"at":"2026-');
  const b = new EventLog(d);
  assert.equal(b.last, 2);
  assert.equal(b.append({ actor: "pandora", kind: "c" }).seq, 3);
  assert.match(fs.readFileSync(path.join(d, "cut-lines.txt"), "utf8"), /"seq":3,"at":"2026-/);
});

test("chats are files; the log keeps facts, not words", () => {
  const d = tmp();
  const log = new EventLog(path.join(d, "log"));
  const chats = new Chats(path.join(d, "chats"), log);
  const c = chats.create("First light", "Mrrowr-murrr", "ferry:test");
  chats.post(c.id, "user", "Good morning, Pandora.", "Mrrowr-murrr", "ferry:test");
  chats.post(c.id, "assistant", "Morning, Partner.", "pandora", "core");
  chats.rename(c.id, "Morning", "pandora", "core");
  const again = new Chats(path.join(d, "chats"), new EventLog(path.join(d, "log")));
  const o = again.open(c.id);
  assert.equal(o.chat.title, "Morning");
  assert.deepEqual(o.messages.map((m) => [m.n, m.role, m.content, m.by]), [[1, "user", "Good morning, Pandora.", "Mrrowr-murrr"], [2, "assistant", "Morning, Partner.", "pandora"]]);
  assert.deepEqual(again.list().map((x) => [x.id, x.messages]), [[c.id, 2]]);
  const logText = fs.readdirSync(path.join(d, "log")).map((f) => fs.readFileSync(path.join(d, "log", f), "utf8")).join("");
  assert.ok(!logText.includes("Good morning"), "no message text in the log");
  assert.match(logText, /"kind":"chat.message".*"sha256":"[0-9a-f]{64}"/);
  fs.appendFileSync(path.join(d, "chats", `${c.id}.jsonl`), '{"type":"message","n":3,"ro');
  assert.equal(again.open(c.id).messages.length, 2, "a torn last line doesn't lose the chat");
});
