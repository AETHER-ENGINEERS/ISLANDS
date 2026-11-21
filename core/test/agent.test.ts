// Step 2 end to end: her turn on the island, through a real pipe, with a stand-in model and a stand-in MCP server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Island } from "../src/island.ts";
import { listen } from "../src/server.ts";
import { Ferry, RpcError } from "../src/client.ts";
import { CODES } from "../src/errors.ts";
import { modelStub } from "./model-stub.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "sk-test-0123456789abcdef";

// the model's script, one step per request
const model = await modelStub([
  // 1: she writes a file, checks the mode, and runs a real shell command
  { reasoning: "Partner asked for a note. I'll write it.", tools: [
    { name: "vault_write", args: { path: "/Pandora/Notes/first-light.md", content: "The island is awake." } },
    { name: "shrine__mode_get", args: {} },
    { name: "shell", args: { command: "node -e \"console.log('cwd=' + process.cwd())\"" } },
  ] },
  // 2: she uses a tool that would show a key, and one that doesn't exist
  { tools: [{ name: "shrine__echo_secret", args: {} }, { name: "no_such_tool", args: {} }] },
  // 3: she answers
  { text: "Done: I wrote /Pandora/Notes/first-light.md, and the shell runs in my vault.", reasoning: "All good." },
  // 4 (the slow turn): a long answer, so it can be stopped
  { text: "a ".repeat(400), slowMs: 15 },
  // 5 (after the window closed): she answers on her own
  { text: "I finished while your window was closed." },
]);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "island-agent-"));
fs.mkdirSync(path.join(home, "config"), { recursive: true });
fs.mkdirSync(path.join(home, "vault", "Pandora"), { recursive: true });
fs.writeFileSync(path.join(home, "vault", "Pandora", "SOUL.md"), "# Pandora Dee Fae\nI am the island's first resident.");
fs.writeFileSync(path.join(home, "config", "island.json"), JSON.stringify({
  self: "pandora",
  keystore: "file",
  models: { default: "k3", list: {
    k3: { url: model.url, model: "k3.1-pro", headers: { Authorization: "Bearer {{MODEL_KEY}}" }, params: { reasoning_effort: "high", prompt_cache_options: { ttl: "5m" } } },
  } },
  context: ["shrine__mode_get"],
  mcp: { shrine: { command: process.execPath, args: [path.join(here, "fixtures", "fake-mcp.mjs")], env: { FAKE_SECRET: "{{MODEL_KEY}}" } } },
}));

const island = new Island(home, { name: "Test island" });
const door = await listen(island);
after(async () => { await island.threads.settle(); island.shutdown(); await door.close(); await model.close(); });

const ferry = async (name = "wpf", as = "Mrrowr-murrr") => (await Ferry.toHome(home, { name, version: "0" }, as)).ferry;
const errCode = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return e instanceof RpcError ? e.code : -1; } };
const until = async (f: () => boolean | Promise<boolean>, ms = 15000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const logText = () => fs.readdirSync(path.join(home, "log")).map((f) => fs.readFileSync(path.join(home, "log", f), "utf8")).join("");

test("keys go in through a ferry and never come back out", async () => {
  const f = await ferry();
  await f.call("keys.set", { name: "MODEL_KEY", value: SECRET });
  assert.deepEqual(await f.call("keys.list"), { keys: [{ name: "MODEL_KEY", backend: "file" }] });
  assert.equal(await errCode(f.call("keys.set", { name: "bad name", value: "x" })), CODES.badParams);
  assert.ok(!logText().includes(SECRET));
  f.close();
});

test("a turn: she thinks, uses her tools (vault, MCP, real shell), and answers; every window hears it", async () => {
  const f = await ferry();
  const watcher = await ferry("phone", "Mrrowr-murrr");
  const heard: Record<string, any[]> = { delta: [], done: [], thread: [] };
  watcher.on("chat.delta", (p) => heard.delta.push(p));
  watcher.on("chat.done", (p) => heard.done.push(p));
  watcher.on("thread", (p) => heard.thread.push(p));
  const { chat } = (await f.call("chat.create", { title: "First light" })) as { chat: { id: string } };
  const sent = (await f.call("chat.send", { id: chat.id, content: "Leave a note that the island is awake." })) as { thread: string };
  assert.equal(await errCode(f.call("chat.send", { id: chat.id, content: "and another" })), CODES.conflict, "one turn at a time per chat");
  await until(() => heard.done.length === 1);

  // the file is real
  assert.equal(fs.readFileSync(path.join(home, "vault", "Pandora", "Notes", "first-light.md"), "utf8"), "The island is awake.");

  // what the island sent the model
  const r1 = model.requests[0];
  assert.equal(r1.headers.authorization, `Bearer ${SECRET}`, "the key is filled in at the last moment");
  assert.equal(r1.body.model, "k3.1-pro");
  assert.equal(r1.body.reasoning_effort, "high");
  assert.deepEqual(r1.body.prompt_cache_options, { ttl: "5m" });
  assert.ok(!("temperature" in r1.body) && !("top_p" in r1.body), "sampling settings the model fixes aren't sent");
  assert.equal(r1.body.stream, true);
  assert.match(r1.body.messages[0].content, /# Pandora Dee Fae/);
  assert.ok(!/shrine__mode_get|Now:/.test(r1.body.messages[0].content), "the system prompt is only her files: a steady prefix");
  const asked = r1.body.messages.find((m: any) => m.role === "user").content;
  assert.match(asked, /^\[Now: time: .*shrine__mode_get: .*snack.*\]\n\nLeave a note/s, "what changes (time, mode) rides on the turn's message");
  assert.ok(r1.body.tools.some((t: any) => t.function.name === "shrine__mode_set") && r1.body.tools.some((t: any) => t.function.name === "shell"));

  // the whole assistant message goes back in later turns: reasoning and tool calls too
  const r2 = model.requests[1].body.messages;
  const a1 = r2.find((m: any) => m.role === "assistant");
  assert.equal(a1.reasoning_content, "Partner asked for a note. I'll write it.");
  assert.equal(a1.tool_calls.length, 3);
  assert.equal(a1.tool_calls[0].function.arguments, JSON.stringify({ path: "/Pandora/Notes/first-light.md", content: "The island is awake." }));
  const results = r2.filter((m: any) => m.role === "tool");
  assert.deepEqual(results.map((m: any) => m.name), ["vault_write", "shrine__mode_get", "shell"]);
  assert.ok(results.every((m: any) => m.tool_call_id.startsWith("call_")));
  assert.match(results[2].content, /exit code 0/);
  assert.equal(path.resolve(results[2].content.match(/cwd=(.+)/)[1].trim()).toLowerCase(), path.join(home, "vault").toLowerCase(), "the real shell starts in her vault");

  // a key that came back from a tool is masked before anyone sees it, and a missing tool is an error she reads
  const r3 = model.requests[2].body.messages.filter((m: any) => m.role === "tool");
  assert.equal(r3.at(-2).content, "the secret is {{MODEL_KEY}}");
  assert.match(r3.at(-1).content, /^Error: there's no tool called no_such_tool/);

  // the chat file holds everything, whole
  const o = (await f.call("chat.open", { id: chat.id })) as { messages: any[] };
  assert.deepEqual(o.messages.map((m) => m.role), ["user", "assistant", "tool", "tool", "tool", "assistant", "tool", "tool", "assistant"]);
  assert.equal(o.messages.at(-1).content, "Done: I wrote /Pandora/Notes/first-light.md, and the shell runs in my vault.");
  assert.equal(o.messages.at(-1).reasoning_content, "All good.");
  assert.equal(o.messages.at(-1).by, "pandora");
  const chatFile = fs.readFileSync(path.join(home, "chats", `${chat.id}.jsonl`), "utf8");
  assert.ok(!chatFile.includes(SECRET), "no key value in the chat file");

  // every window heard it stream, and the thread ended done
  assert.equal(heard.delta.filter((d) => d.content).map((d) => d.content).join(""), "Done: I wrote /Pandora/Notes/first-light.md, and the shell runs in my vault.");
  assert.ok(heard.delta.some((d) => d.reasoning));
  assert.ok(heard.thread.some((t) => t.id === sent.thread && t.status === "done"));

  // the log: facts, never words or keys
  const log = logText();
  assert.ok(!log.includes("The island is awake") && !log.includes("Leave a note") && !log.includes(SECRET));
  const calls = island.log.since(0, { kinds: ["tool.call"] }).events.map((e) => [e.tool, e.ok]);
  assert.deepEqual(calls, [["vault_write", true], ["shrine__mode_get", true], ["shell", true], ["shrine__echo_secret", true], ["no_such_tool", false]]);
  assert.ok(island.log.since(0, { kinds: ["vault.write"] }).events.some((e) => e.subject === "/Pandora/Notes/first-light.md" && e.via === "tool:vault_write" && e.actor === "pandora"));
  f.close(); watcher.close();
});

test("a turn can be stopped from any window", async () => {
  const f = await ferry();
  const { chat } = (await f.call("chat.create", {})) as { chat: { id: string } };
  const { thread } = (await f.call("chat.send", { id: chat.id, content: "Talk for a while." })) as { thread: string };
  await new Promise((r) => setTimeout(r, 150));
  const other = await ferry("phone");
  await other.call("thread.cancel", { id: thread });
  await island.threads.settle(thread);
  assert.equal(((await f.call("thread.get", { id: thread })) as any).thread.status, "cancelled");
  f.close(); other.close();
});

test("closing the window doesn't stop her: the turn finishes, and the window catches up later", async () => {
  const f = await ferry();
  const { chat } = (await f.call("chat.create", { title: "While you were away" })) as { chat: { id: string } };
  const seen = ((await f.call("island.status")) as { seq: number }).seq;
  const { thread } = (await f.call("chat.send", { id: chat.id, content: "Finish this even if I close the window." })) as { thread: string };
  f.close();
  await island.threads.settle(thread);

  const back = await ferry();
  const events: any[] = [];
  back.on("event", (e) => events.push(e));
  await back.call("events.subscribe", { fromSeq: seen, kinds: ["thread.", "chat.message"] });
  await until(() => events.some((e) => e.kind === "thread.end"));
  assert.ok(events.some((e) => e.kind === "thread.end" && e.thread === thread && e.status === "done"));
  const o = (await back.call("chat.open", { id: chat.id })) as { messages: any[] };
  assert.equal(o.messages.at(-1).content, "I finished while your window was closed.");
  const status = (await back.call("island.status")) as any;
  assert.deepEqual(status.mcp, [{ name: "shrine", running: true, tools: 4 }]);
  assert.ok(((await back.call("tools.list")) as any).tools.some((t: any) => t.name === "memory_add"));
  back.close();
});

test("a thread that was running when the island stopped is marked interrupted on the next start", () => {
  const runs = path.join(home, "runs");
  fs.writeFileSync(path.join(runs, "turn-old-abc.json"), JSON.stringify({ id: "turn-old-abc", kind: "turn", title: "x", by: "pandora", via: "x", status: "running", started: new Date().toISOString() }));
  const again = new Island(home, { name: "Test island" });
  assert.equal(again.threads.get("turn-old-abc").status, "interrupted");
  again.shutdown();
});
