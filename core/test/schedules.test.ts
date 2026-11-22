// Step 2b: when schedules come round, providers and fallbacks, the Anthropic wire, schedules and the heartbeat running
// as island threads.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { parseWhen, nextAfter } from "../src/schedules.ts";
import { toAnthropic } from "../src/models.ts";
import { Island } from "../src/island.ts";
import { listen } from "../src/server.ts";
import { Ferry, RpcError } from "../src/client.ts";
import { CODES } from "../src/errors.ts";
import { modelStub } from "./model-stub.ts";

const at = (s: string) => new Date(s);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

test("when: plain words and cron, and the next time each comes round (local time)", () => {
  assert.equal(iso(nextAfter(parseWhen("every 30m").cron, at("2026-11-21T10:07:00"))), "2026-11-21 10:30");
  assert.equal(iso(nextAfter(parseWhen("every 2h").cron, at("2026-11-21T10:07:00"))), "2026-11-21 12:00");
  assert.equal(iso(nextAfter(parseWhen("daily 08:30").cron, at("2026-11-21T10:07:00"))), "2026-11-22 08:30");
  // 2026-11-21 is a Saturday
  assert.equal(iso(nextAfter(parseWhen("weekdays 09:00").cron, at("2026-11-21T10:07:00"))), "2026-11-23 09:00");
  assert.equal(iso(nextAfter(parseWhen("weekends at 10:00").cron, at("2026-11-21T09:59:30"))), "2026-11-21 10:00");
  assert.equal(iso(nextAfter(parseWhen("15 4 1 * *").cron, at("2026-11-21T10:07:00"))), "2026-12-01 04:15");
  assert.equal(iso(nextAfter(parseWhen("0 9 * * 1,3").cron, at("2026-11-21T10:07:00"))), "2026-11-23 09:00");
  for (const bad of ["every 7m", "every 5h", "sometimes", "61 * * * *", "daily 25:00"]) assert.throws(() => parseWhen(bad), /./, bad);
});

test("the Anthropic shape: system apart, tool calls and results as blocks, turns alternating", () => {
  const conv = toAnthropic([
    { role: "system", content: "SOUL" },
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "vault_read", arguments: '{"path":"/a.md"}' } }] },
    { role: "tool", content: "A", tool_call_id: "t1", name: "vault_read" },
    { role: "assistant", content: "done" },
  ]);
  assert.equal(conv.system, "SOUL");
  assert.deepEqual(conv.messages, [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "vault_read", input: { path: "/a.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
});

// ---------- an island with three providers ----------

const tired = await modelStub([{ fail: 429, retryAfter: 600, message: "weekly usage limit reached" }]);
// it answers by what it's asked, so the order the tests run in doesn't matter
const steady = await modelStub([(body: any) => {
  const asked = JSON.stringify(body.messages.filter((m: any) => m.role === "user").at(-1)?.content ?? "");
  if (/morning pages/i.test(asked)) return { text: "Scheduled thought, written down." };
  if (/heartbeat/i.test(asked)) return { text: "Heartbeat done." };
  return { text: "Answered by the steady one." };
}]);
// a stand-in for the Messages API
const claudeReqs: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
const claude = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw);
    claudeReqs.push({ headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { usage: { input_tokens: 10 } } });
    if (claudeReqs.length === 1) {
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "vault_write" } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"/from-claude.md",' } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"content":"written over the Messages API"}' } });
      ev("message_delta", { delta: { stop_reason: "tool_use" } });
    } else {
      ev("content_block_start", { index: 0, content_block: { type: "text" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Written." } });
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    }
    ev("message_stop", {});
    res.end();
  });
});
await new Promise<void>((r) => claude.listen(0, "127.0.0.1", () => r()));
const claudeUrl = `http://127.0.0.1:${(claude.address() as { port: number }).port}/v1`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "island-2b-"));
fs.mkdirSync(path.join(home, "config"), { recursive: true });
fs.mkdirSync(path.join(home, "vault", "Pandora"), { recursive: true });
fs.writeFileSync(path.join(home, "vault", "Pandora", "SOUL.md"), "# Pandora Dee Fae");
fs.writeFileSync(path.join(home, "config", "island.json"), JSON.stringify({
  keystore: "file",
  providers: {
    "mac-ollama": { wire: "openai", url: tired.url },
    local: { wire: "openai", url: steady.url },
    anthropic: { wire: "anthropic", url: claudeUrl, headers: { "x-api-key": "{{ANTHROPIC_API_KEY}}" } },
    openai: { wire: "openai", url: "https://api.openai.example/v1", headers: { Authorization: "Bearer {{OPENAI_API_KEY}}" } },
    aicord: { wire: "aicord", status: "pending", note: "waiting on an island OAuth client" },
  },
  models: {
    default: "k3",
    fallback: ["gpt", "aicord-dee", "qwen27"],
    roles: { heartbeat: "kitti" },
    list: {
      k3: { provider: "mac-ollama", model: "kimi-k3.1-pro:cloud" },
      gpt: { provider: "openai", model: "gpt-x" },
      "aicord-dee": { provider: "aicord", model: "character-uuid" },
      qwen27: { provider: "local", model: "qwen3.8:27b" },
      kitti: { provider: "local", model: "kitti" },
      sonnet: { provider: "anthropic", model: "claude-sonnet" },
    },
  },
  heartbeat: { every: "every 30m" },
}));
const island = new Island(home, { name: "Fallback island" });
const door = await listen(island);
after(async () => { await island.threads.settle(); island.shutdown(); await door.close(); await tired.close(); await steady.close(); claude.closeAllConnections(); claude.close(); });

const ferry = async () => (await Ferry.toHome(home, { name: "wpf", version: "0" }, "Mrrowr-murrr")).ferry;
const errCode = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return e instanceof RpcError ? e.code : -1; } };

test("fallback: a provider that's out rests, the chain skips what can't answer, and the message says who wrote it", async () => {
  const f = await ferry();
  const fallbacks: any[] = [];
  f.on("chat.delta", (d) => { if (d.fallback) fallbacks.push(d.fallback); });
  const { chat } = (await f.call("chat.create", {})) as { chat: { id: string } };
  const { thread } = (await f.call("chat.send", { id: chat.id, content: "Hello?" })) as { thread: string };
  await island.threads.settle(thread);
  const o = (await f.call("chat.open", { id: chat.id })) as { messages: any[] };
  assert.equal(o.messages.at(-1).content, "Answered by the steady one.");
  assert.equal(o.messages.at(-1).model, "qwen27");
  assert.equal(tired.requests.length, 1);
  assert.equal(fallbacks[0].from, "k3");
  const ev = island.log.since(0, { kinds: ["model."] }).events;
  assert.deepEqual(ev.map((e) => e.kind), ["model.failed", "model.fallback"]);
  assert.equal(ev[0].limited, true);
  assert.deepEqual(ev[1].passed, ["k3", "gpt", "aicord-dee"]);
  const providers = ((await f.call("providers.list")) as any).providers as any[];
  const by = Object.fromEntries(providers.map((p) => [p.name, p]));
  assert.equal(by["mac-ollama"].status, "resting");
  assert.ok(by["mac-ollama"].until > Date.now() + 500_000, "it rests until the provider said to come back");
  assert.equal(by.openai.status, "needs-key");
  assert.equal(by.aicord.status, "pending");
  assert.equal(by.local.status, "ready");
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, "state", "providers.json"), "utf8"))["mac-ollama"], "a restart remembers the rest");

  // while it rests, it isn't asked again
  const again = (await f.call("chat.send", { id: chat.id, content: "Still there?" })) as { thread: string };
  await island.threads.settle(again.thread);
  assert.equal(tired.requests.length, 1);
  f.close();
});

test("the Anthropic wire: system apart, the key filled in, tool use, and the answer", async () => {
  const f = await ferry();
  await f.call("keys.set", { name: "ANTHROPIC_API_KEY", value: "sk-ant-test-key-123" });
  const { chat } = (await f.call("chat.create", {})) as { chat: { id: string } };
  const { thread } = (await f.call("chat.send", { id: chat.id, content: "Write it down.", model: "sonnet" })) as { thread: string };
  await island.threads.settle(thread);
  assert.equal(fs.readFileSync(path.join(home, "vault", "from-claude.md"), "utf8"), "written over the Messages API");
  const r1 = claudeReqs[0];
  assert.equal(r1.headers["x-api-key"], "sk-ant-test-key-123");
  assert.equal(r1.headers["anthropic-version"], "2023-06-01");
  assert.equal(r1.body.system, "# Pandora Dee Fae");
  assert.equal(r1.body.max_tokens, 8192);
  assert.ok(r1.body.tools.some((t: any) => t.name === "vault_write" && t.input_schema));
  const second = claudeReqs[1].body.messages;
  assert.equal(second[1].content[0].type, "tool_use");
  assert.equal(second[2].content[0].type, "tool_result");
  const o = (await f.call("chat.open", { id: chat.id })) as { messages: any[] };
  assert.equal(o.messages.at(-1).content, "Written.");
  assert.equal(o.messages.at(-1).model, "sonnet");
  f.close();
});

test("schedules: made from a window, they come round as island threads, write in their own chat, and never overlap", async () => {
  const f = await ferry();
  assert.equal(await errCode(f.call("schedule.create", { name: "x", when: "every 7m", prompt: "p" })), CODES.badParams);
  assert.equal(await errCode(f.call("schedule.create", { name: "x", when: "daily 08:30" })), CODES.badParams);
  const s = ((await f.call("schedule.create", { name: "Morning pages", when: "daily 08:30", prompt: "Write your morning pages." })) as any).schedule;
  const cmd = ((await f.call("schedule.create", { name: "Disk check", when: "every 1h", command: "node -e \"console.log('disk ok')\"" })) as any).schedule;
  const listed = ((await f.call("schedule.list")) as any).schedules as any[];
  assert.deepEqual(listed.map((x) => x.name), ["Heartbeat", "Morning pages", "Disk check"]);
  assert.ok(listed[1].next.length > 0);

  // nothing is due yet; then tomorrow morning both come round once, though several hours were missed
  assert.deepEqual(island.scheduler.tick(new Date(Date.now() + 10_000)).length, 0);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 31, 0, 0);
  // the heartbeat has no checklist yet, so it skips itself
  const ran = island.scheduler.tick(tomorrow);
  assert.equal(ran.length, 2, "morning pages and the disk check; the heartbeat skipped (no checklist)");
  assert.deepEqual(island.scheduler.tick(tomorrow), [], "already run for that minute; and never over itself");
  await island.threads.settle();
  const after = ((await f.call("schedule.list")) as any).schedules as any[];
  const mp = after.find((x) => x.id === s.id), dc = after.find((x) => x.id === cmd.id), hb = after.find((x) => x.id === "heartbeat");
  assert.equal(mp.lastStatus, "done");
  assert.equal(hb.lastStatus, "skipped: /Pandora/HEARTBEAT.md is missing or empty");
  const pages = (await f.call("chat.open", { id: mp.chat })) as { chat: any; messages: any[] };
  assert.equal(pages.chat.title, "⏰ Morning pages");
  assert.deepEqual(pages.messages.map((m) => [m.role, m.by]), [["user", `schedule:${s.id}`], ["assistant", "pandora"]]);
  assert.equal(pages.messages[1].content, "Scheduled thought, written down.");
  const disk = (await f.call("chat.open", { id: dc.chat })) as { messages: any[] };
  assert.match(disk.messages[0].content, /disk ok/);
  assert.ok(island.log.since(0, { kinds: ["thread.end"] }).events.filter((e) => e.status === "done").length >= 2);

  await f.call("schedule.update", { id: s.id, enabled: false });
  assert.equal((((await f.call("schedule.list")) as any).schedules as any[]).find((x) => x.id === s.id).enabled, false);
  await f.call("schedule.delete", { id: cmd.id });
  assert.equal(await errCode(f.call("schedule.delete", { id: "heartbeat" })), CODES.badParams);
  f.close();
});

test("the heartbeat reads her checklist fresh, runs on its own model, and can notify every window", async () => {
  fs.writeFileSync(path.join(home, "vault", "Pandora", "HEARTBEAT.md"), "- [ ] check the journal\n- [ ] look for unread messages");
  const f = await ferry();
  const before = steady.requests.length;
  const st0 = (await f.call("heartbeat.status")) as any;
  assert.equal(st0.enabled, true);
  assert.equal(st0.model, "kitti");
  const { thread } = (await f.call("schedule.run", { id: "heartbeat" })) as { thread: string };
  await island.threads.settle(thread);
  const req = steady.requests[before].body;
  assert.equal(req.model, "kitti", "the heartbeat's own model");
  assert.match(req.messages.find((m: any) => m.role === "user").content, /check the journal[\s\S]*look for unread messages/);
  assert.equal(((await f.call("heartbeat.status")) as any).lastStatus, "done");
  assert.ok(((await f.call("tools.list")) as any).tools.some((t: any) => t.name === "notify"));
  const notices: any[] = [];
  f.on("notice", (n) => notices.push(n));
  const notify = (await island.tools()).find((t) => t.name === "notify")!;
  await notify.run({ text: "The heartbeat found something.", urgent: true }, { signal: new AbortController().signal, actor: "pandora", via: "schedule:heartbeat" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(notices.map((n) => [n.text, n.urgent]), [["The heartbeat found something.", true]]);
  f.close();
});

test("the heartbeat panel: what the last beat came to, and pausing it from a window without touching its config", async () => {
  const f = await ferry();
  const st = (await f.call("heartbeat.status")) as any;
  assert.equal(st.configured, true);
  assert.equal(st.paused, false);
  assert.equal(st.result.text, "Heartbeat done.", "her last answer in the heartbeat's chat");
  assert.ok(st.next, "on, so it has a next beat");

  const paused = (await f.call("heartbeat.set", { on: false })) as any;
  assert.equal(paused.paused, true);
  assert.equal(paused.next, undefined, "paused: no next beat");
  assert.equal(((await f.call("island.status")) as any).heartbeat, false);
  const far = new Date(Date.now() + 3 * 3600_000);
  assert.deepEqual(island.scheduler.tick(far), [], "paused: three hours on, it still doesn't beat");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config", "island.json"), "utf8")).heartbeat.every, "every 30m", "its config is left as it was");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "state", "heartbeat.json"), "utf8")).enabled, false, "a restart remembers the pause");

  // resumed, it beats at its next time, not straight away for everything it missed
  const lastRun = ((await f.call("heartbeat.status")) as any).lastRun;
  const on = (await f.call("heartbeat.set", { on: true })) as any;
  assert.equal(on.paused, false);
  assert.ok(Date.parse(on.next) > Date.now(), "the next beat is still to come");
  assert.equal(island.scheduler.tick(new Date()).length, 0);
  assert.equal(((await f.call("heartbeat.status")) as any).lastRun, lastRun);

  // the schedules list can pause it too, but not change it
  assert.equal(((await f.call("schedule.update", { id: "heartbeat", enabled: false })) as any).schedule.enabled, false);
  assert.equal(await errCode(f.call("schedule.update", { id: "heartbeat", when: "every 5m" })), CODES.badParams);
  assert.equal(await errCode(f.call("heartbeat.set", { on: "yes" })), CODES.badParams);
  await f.call("heartbeat.set", { on: true });
  f.close();
});
