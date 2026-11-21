// The ferry protocol end to end: a real core on a real pipe or socket, real ferries talking to it (docs/protocol.md).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Island } from "../src/island.ts";
import { listen } from "../src/server.ts";
import { Ferry, RpcError } from "../src/client.ts";
import { CODES } from "../src/errors.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "island-proto-"));
const island = new Island(home, { name: "test-island" });
const door = await listen(island);
after(() => door.close());

const errCode = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return e instanceof RpcError ? e.code : -1; } };
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("core.json names the door; nothing is answered before hello", async () => {
  const info = JSON.parse(fs.readFileSync(path.join(home, "state", "core.json"), "utf8"));
  assert.equal(info.endpoint, door.endpoint);
  const f = await Ferry.connect(door.endpoint);
  assert.equal(await errCode(f.call("vault.list")), CODES.noHello);
  const closed = new Promise((r) => f.once("close", r));
  assert.equal(await errCode(f.call("island.hello", { token: "not-it" })), CODES.noHello);
  await closed;   // a wrong token ends the connection
});

test("hello, then the vault: files on disk, facts in the log", async () => {
  const { ferry: f, hello } = await Ferry.toHome(home, { name: "wpf", version: "0.1" }, "Mrrowr-murrr");
  assert.equal(typeof hello.seq, "number");
  const w = (await f.call("vault.write", { path: "/Pandora/SOUL.md", text: "# Pandora Dee Fae\n" })) as { mtime: number };
  assert.equal(fs.readFileSync(path.join(home, "vault", "Pandora", "SOUL.md"), "utf8"), "# Pandora Dee Fae\n");
  assert.deepEqual(await f.call("vault.read", { path: "/Pandora/SOUL.md" }), { path: "/Pandora/SOUL.md", size: 18, mtime: w.mtime, text: "# Pandora Dee Fae\n" });
  await f.call("vault.write", { path: "/Pandora/pic.bin", base64: Buffer.from([0, 1, 254, 255]).toString("base64") });
  assert.equal(((await f.call("vault.read", { path: "/Pandora/pic.bin", encoding: "base64" })) as { base64: string }).base64, "AAH+/w==");
  assert.equal(await errCode(f.call("vault.write", { path: "/Pandora/SOUL.md", text: "x", ifMtime: w.mtime - 5000 })), CODES.conflict);
  assert.equal(await errCode(f.call("vault.read", { path: "/../outside.md" })), CODES.refused);
  assert.equal(await errCode(f.call("vault.read", { path: "/nope.md" })), CODES.notFound);
  assert.equal(await errCode(f.call("vault.write", { path: "/x.md" })), CODES.badParams);
  assert.equal(await errCode(f.call("no.such")), CODES.noMethod);
  await f.call("vault.move", { from: "/Pandora/pic.bin", to: "/Pandora/art/pic.bin" });
  const del = (await f.call("vault.delete", { path: "/Pandora/art/pic.bin" })) as { trash: string };
  assert.ok(fs.existsSync(del.trash));
  const list = (await f.call("vault.list")) as { entries: { path: string }[] };
  assert.deepEqual(list.entries.map((e) => e.path), ["/Pandora", "/Pandora/SOUL.md", "/Pandora/art"]);
  const { events } = (await f.call("events.since", { fromSeq: hello.seq, kinds: ["vault."] })) as { events: Array<Record<string, unknown>> };
  assert.deepEqual(events.map((e) => [e.kind, e.subject, e.actor, e.via]), [
    ["vault.write", "/Pandora/SOUL.md", "Mrrowr-murrr", "ferry:wpf"],
    ["vault.write", "/Pandora/pic.bin", "Mrrowr-murrr", "ferry:wpf"],
    ["vault.move", "/Pandora/pic.bin", "Mrrowr-murrr", "ferry:wpf"],
    ["vault.delete", "/Pandora/art/pic.bin", "Mrrowr-murrr", "ferry:wpf"],
  ]);
  const logText = fs.readdirSync(path.join(home, "log")).map((x) => fs.readFileSync(path.join(home, "log", x), "utf8")).join("");
  assert.ok(!logText.includes("# Pandora Dee Fae"), "file contents never go in the log");
  f.close();
});

test("a ferry that comes back catches up from its last seq, then hears what happens live, in order", async () => {
  const { ferry: a } = await Ferry.toHome(home, { name: "wpf", version: "0.1" }, "Mrrowr-murrr");
  const c = ((await a.call("chat.create", { title: "Island morning" })) as { chat: { id: string } }).chat;
  const lastSeen = (await a.call("island.status")) as { seq: number };
  a.close();

  // while that window is closed, the island keeps going
  const { ferry: b } = await Ferry.toHome(home, { name: "cli", version: "0" }, "pandora");
  await b.call("chat.post", { id: c.id, role: "assistant", content: "I kept the fire going." });
  await b.call("vault.write", { path: "/Pandora/Journal/2026-11-21.md", text: "a quiet morning" });

  // the window comes back and asks for everything since what it last saw
  const { ferry: a2 } = await Ferry.toHome(home, { name: "wpf", version: "0.1" }, "Mrrowr-murrr");
  const got: Array<Record<string, unknown>> = [];
  a2.on("event", (e) => got.push(e));
  const sub = (await a2.call("events.subscribe", { fromSeq: lastSeen.seq, kinds: ["chat.", "vault."] })) as { seq: number };
  await b.call("vault.write", { path: "/Pandora/Journal/2026-11-21.md", text: "a quiet morning, and then tea" });
  await tick();
  assert.deepEqual(got.map((e) => [e.kind, e.actor]), [["chat.message", "pandora"], ["vault.write", "pandora"], ["vault.write", "pandora"]]);
  const seqs = got.map((e) => e.seq as number);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), "in order");
  assert.ok(seqs[1] <= sub.seq && seqs[2] > sub.seq, "two caught up, one live");
  const o = (await a2.call("chat.open", { id: c.id })) as { messages: Array<{ content: string; by: string }> };
  assert.deepEqual(o.messages.map((m) => [m.by, m.content]), [["pandora", "I kept the fire going."]]);

  await a2.call("events.unsubscribe");
  await b.call("vault.write", { path: "/after.md", text: "x" });
  await tick();
  assert.equal(got.length, 3, "nothing after unsubscribing");
  const status = (await b.call("island.status")) as { name: string; ferries: Array<{ ferry: string }>; vault: { files: number } };
  assert.equal(status.name, "test-island");
  assert.deepEqual(status.ferries.map((x) => x.ferry).sort(), ["cli", "wpf"]);
  a2.close(); b.close();
});

test("bad lines get errors, and the connection still works", async () => {
  const { ferry: f } = await Ferry.toHome(home, { name: "t", version: "0" }, "someone");
  const errs: RpcError[] = [];
  f.on("rpc-error", (e) => errs.push(e));
  f.raw("this is not json\n");
  f.raw('{"jsonrpc":"1.0","method":"x"}\n');
  await tick();
  assert.deepEqual(errs.map((e) => e.code), [CODES.parse, CODES.invalidRequest]);
  assert.ok(((await f.call("island.status")) as { seq: number }).seq > 0);
  f.close();
});

test("ferries come and go in the log", async () => {
  await tick();
  const kinds = island.log.since(0, { kinds: ["ferry."] }).events.map((e) => e.kind);
  assert.ok(kinds.includes("ferry.hello") && kinds.includes("ferry.bye"));
});
