// Her turn: what she reads (her own files are her system prompt), what she thinks (the model, streamed to every window
// that's watching), and what she does (her tools), until she answers. A turn is an island thread, so closing the
// window that asked doesn't stop it; everything she says and does is kept in the chat file as it happens.
//
// Two things keep it kind to caches and steady when a provider runs out:
// - The system prompt is only her files, the same from turn to turn, so a provider's cache (and Ollama's prefix reuse)
//   can keep it. What changes (the time, her mode) rides on the message that starts the turn, in the request only.
// - Models are tried in order: the one asked for, then the fallbacks. A provider that says it's out rests until it
//   resets; each message records which model wrote it, and the log records every switch and why.

import type { Island } from "./island.ts";
import type { ThreadContext } from "./threads.ts";
import { complete, ModelError, type ModelMessage, type Reply } from "./models.ts";
import { DEFAULT_REST_MS } from "./providers.ts";
import { spec, type Tool } from "./tools.ts";
import type { Message } from "./chats.ts";

const MAX_TOOL_RESULT = 100_000;

/** Her system prompt: her own files, in order. The same from turn to turn while they don't change. */
export function systemPrompt(island: Island): string {
  const parts: string[] = [];
  for (const p of island.config.system) {
    try { parts.push(island.vault.read(p).data.toString("utf8").trim()); } catch {}
  }
  return island.keys.mask(parts.filter(Boolean).join("\n\n"));
}

/** What's true right now, once per turn: the time, the place, and what the context tools say (her mode). */
export async function nowNote(island: Island, tools: Tool[], signal: AbortSignal): Promise<string> {
  const now: string[] = [`time: ${new Date().toString()}`, `place: your island, "${island.name}" (your vault is real files; your shell runs real programs)`];
  for (const c of await nowContext(island, tools, signal)) now.push(`${c.tool}: ${c.text}`);
  return island.keys.mask(`[Now: ${now.join("; ")}]`);
}

/** What each context tool says right now (her mode, from the mode shrine), for her turn and for the ferry's Now bar. */
export async function nowContext(island: Island, tools: Tool[], signal: AbortSignal): Promise<Array<{ tool: string; text: string }>> {
  const out: Array<{ tool: string; text: string }> = [];
  for (const name of island.config.context) {
    const t = tools.find((x) => x.name === name);
    if (!t) continue;
    try { out.push({ tool: name, text: island.keys.mask(String(await t.run({}, { signal, actor: island.config.self, via: "core" })).slice(0, 2000)) }); } catch {}
  }
  return out;
}

/** The chat as the model reads it: every message whole, as it was kept. */
export function history(messages: Message[], keepReasoning: boolean): ModelMessage[] {
  return messages.map((m) => {
    const out: ModelMessage = { role: m.role, content: m.content };
    if (m.role === "assistant") {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) { out.tool_calls = m.tool_calls as ModelMessage["tool_calls"]; if (!m.content) out.content = null; }
      if (keepReasoning && typeof m.reasoning_content === "string") out.reasoning_content = m.reasoning_content;
    }
    if (m.role === "tool") { out.tool_call_id = String(m.tool_call_id ?? ""); if (typeof m.name === "string") out.name = m.name; }
    return out;
  });
}

/** Ask the first model in the chain that can answer. Returns which one did. */
async function ask(island: Island, chain: string[], build: (keepReasoning: boolean) => ModelMessage[], tools: Tool[], ctx: ThreadContext, opts: { params?: Record<string, unknown>; chat: string }) {
  const tried: string[] = [];
  let last: Error | undefined;
  for (const name of chain) {
    const ok = island.providers.check(name);
    if (!ok.ok) { tried.push(`${name}: ${ok.why}`); continue; }
    const r = island.providers.resolve(name);
    const keep = r.cfg.keepReasoning !== false;
    try {
      const reply: Reply = await complete(r, island.keys, build(keep), tools.map(spec), {
        extra: opts.params,
        signal: ctx.signal,
        onDelta: (d) => island.broadcast("chat.delta", { chat: opts.chat, thread: ctx.id, ...(d.content ? { content: island.keys.mask(d.content) } : {}), ...(d.reasoning ? { reasoning: island.keys.mask(d.reasoning) } : {}) }),
      });
      if (tried.length) island.log.append({ actor: island.config.self, via: `thread:${ctx.id}`, kind: "model.fallback", to: name, passed: tried.map((t) => t.split(":")[0]), chat: opts.chat });
      return { reply, name, keep };
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      if (!(e instanceof ModelError) || e.emitted) throw e;   // words already went out: don't say them twice with another model
      last = e;
      if (e.limited) island.providers.rest(r.provider, e.retryAt ?? Date.now() + DEFAULT_REST_MS, e.message);
      tried.push(`${name}: ${e.message}`);
      island.log.append({ actor: island.config.self, via: `thread:${ctx.id}`, kind: "model.failed", model: name, provider: r.provider, status: e.status, limited: e.limited, ...(e.limited ? { restUntil: e.retryAt ?? Date.now() + DEFAULT_REST_MS } : {}) });
      island.broadcast("chat.delta", { chat: opts.chat, thread: ctx.id, fallback: { from: name, reason: e.message.slice(0, 300) } });
    }
  }
  throw new Error(`no model could answer. ${tried.join(" | ")}${last && !tried.length ? last.message : ""}`);
}

export async function runTurn(island: Island, chat: string, opts: { model?: string; params?: Record<string, unknown>; purpose?: string }, ctx: ThreadContext) {
  const chain = island.providers.chain(opts.model, opts.purpose);
  const self = island.config.self;
  const via = `thread:${ctx.id}`;
  const tools = await island.tools();
  const say = (params: Record<string, unknown>) => island.broadcast("chat.delta", { chat, thread: ctx.id, ...params });
  const system = systemPrompt(island);
  const now = await nowNote(island, tools, ctx.signal);
  // the message that started this turn: the last one a person (or a schedule) posted
  const startN = [...island.chats.open(chat).messages].reverse().find((m) => m.role === "user")?.n;

  for (let step = 0; step < island.config.maxSteps; step++) {
    if (ctx.signal.aborted) throw new Error("stopped");
    ctx.progress(step ? `thinking (step ${step + 1})` : "thinking");
    const kept = island.chats.open(chat).messages;
    const build = (keep: boolean): ModelMessage[] => [
      { role: "system", content: system },
      ...history(kept, keep).map((m, i) => (kept[i].n === startN ? { ...m, content: `${now}\n\n${m.content ?? ""}` } : m)),
    ];
    const { reply, name } = await ask(island, chain, build, tools, ctx, { params: opts.params, chat });
    const keep = island.providers.resolve(name).cfg.keepReasoning !== false;
    const m = reply.message;
    const extra: Record<string, unknown> = { model: name };
    if (m.tool_calls) extra.tool_calls = m.tool_calls;
    if (keep && m.reasoning_content) extra.reasoning_content = island.keys.mask(m.reasoning_content);
    const posted = island.chats.post(chat, "assistant", island.keys.mask(m.content ?? ""), self, via, extra);
    say({ message: posted.n, done: !m.tool_calls, model: name });

    if (!m.tool_calls?.length) {
      island.broadcast("chat.done", { chat, thread: ctx.id, n: posted.n, finish: reply.finish, usage: reply.usage, model: name });
      return;
    }

    for (const call of m.tool_calls) {
      const tool = tools.find((t) => t.name === call.function.name);
      const t0 = Date.now();
      let out: string;
      let ok = true;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("the arguments must be a JSON object");
        if (!tool) throw new Error(`there's no tool called ${call.function.name}`);
        ctx.progress(`${tool.name}${tool.subject ? ` ${tool.subject(args) ?? ""}` : ""}`.trim());
        out = String(await tool.run(args, { signal: ctx.signal, actor: self, via: `tool:${tool.name}` }));
      } catch (e) {
        ok = false;
        out = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      out = island.keys.mask(out);
      if (out.length > MAX_TOOL_RESULT) out = out.slice(0, MAX_TOOL_RESULT) + `\n… (cut: ${out.length} characters in all)`;
      let subject: string | undefined;
      try { subject = tool?.subject?.(args); } catch {}
      island.log.append({ actor: self, via, kind: "tool.call", tool: call.function.name, ...(subject ? { subject: island.keys.mask(subject) } : {}), ok, ms: Date.now() - t0 });
      island.chats.post(chat, "tool", out, self, via, { tool_call_id: call.id, name: call.function.name });
      say({ tool: call.function.name, ok });
      if (ctx.signal.aborted) throw new Error("stopped");
    }
  }
  island.chats.post(chat, "assistant", `(I stopped after ${island.config.maxSteps} steps in one turn. Say "go on" and I'll continue.)`, self, via, {});
  island.broadcast("chat.done", { chat, thread: ctx.id, finish: "steps" });
}
