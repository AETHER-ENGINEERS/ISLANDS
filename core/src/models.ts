// Talking to a model, streamed, over one of two wires:
// - "openai": Chat Completions (Ollama, Ollama Cloud, OpenAI, xAI, Groq, llama.cpp, Moonshot, Shapes …)
// - "anthropic": the Messages API
// Per-model settings ride along (reasoning_effort, prompt_cache_options …), settings a model fixes are never sent, and
// the whole assistant message (reasoning and tool calls too) comes back to be kept. A failure says whether anything
// was already streamed, so the caller knows whether trying another model is safe.

import type { ModelConfig, ProviderConfig } from "./config.ts";
import type { Keys } from "./keys.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface Reply {
  message: ModelMessage;
  finish: string;
  usage?: Record<string, unknown>;
}
/** A model as the island resolved it: its own settings, plus its provider's wire, address and headers. */
export interface Resolved {
  name: string;
  provider: string;
  wire: ProviderConfig["wire"];
  cfg: ModelConfig & { url: string };
}

export class ModelError extends Error {
  status: number;
  /** Words had already reached the windows: trying another model would say things twice */
  emitted: boolean;
  /** When the provider says to come back (ms since epoch), for limits and rate limits */
  retryAt?: number;
  constructor(message: string, status = 0, emitted = false, retryAt?: number) {
    super(message);
    this.status = status;
    this.emitted = emitted;
    this.retryAt = retryAt;
  }
  /** Out of its limit or rate limit: the provider should rest */
  get limited() {
    return this.status === 429 || this.status === 402 || /quota|rate.?limit|usage limit|session limit|weekly limit|exceeded/i.test(this.message);
  }
}

/** Sampling settings that are never sent unless a model's own params name them (some models fix them and refuse). */
const SAMPLING = ["temperature", "top_p", "n", "presence_penalty", "frequency_penalty"];

export function requestBody(cfg: ModelConfig, messages: ModelMessage[], tools: ToolSpec[], extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = { ...(cfg.params ?? {}), ...extra, model: cfg.model, messages, stream: true };
  if (tools.length) body.tools = tools;
  for (const k of cfg.omit ?? SAMPLING.filter((s) => !(cfg.params && s in cfg.params))) delete body[k];
  return body;
}

function retryAtOf(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Date.now() + secs * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? t : undefined;
}

async function post(url: string, headers: Record<string, string>, body: unknown, keys: Keys, model: string, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ModelError(`${model}: couldn't reach ${new URL(url).host} (${(e as Error).cause ? String((e as any).cause?.code ?? (e as any).cause?.message) : (e as Error).message})`);
  }
  if (!res.ok || !res.body) {
    const text = keys.mask(await res.text().catch(() => ""));
    throw new ModelError(`${model} at ${new URL(url).host} answered ${res.status}: ${text.slice(0, 600)}`, res.status, false, retryAtOf(res));
  }
  return res;
}

/** Read a server-sent-events body, line by line. */
async function* events(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  const dec = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(part, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) { yield { event, data: line.slice(5).trim() }; }
      else if (!line) event = undefined;
    }
  }
}

type Opts = { extra?: Record<string, unknown>; signal?: AbortSignal; onDelta?: (d: { content?: string; reasoning?: string }) => void };

/** One call to the model, streamed. `onDelta` hears text and reasoning as they arrive. The result is the whole message. */
export async function complete(r: Resolved, keys: Keys, messages: ModelMessage[], tools: ToolSpec[], opts: Opts = {}): Promise<Reply> {
  if (r.wire === "anthropic") return anthropic(r, keys, messages, tools, opts);
  if (r.wire !== "openai") throw new ModelError(`${r.name}: the ${r.wire} wire isn't built yet`);
  return openai(r, keys, messages, tools, opts);
}

async function openai(r: Resolved, keys: Keys, messages: ModelMessage[], tools: ToolSpec[], opts: Opts): Promise<Reply> {
  const cfg = r.cfg;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = keys.fill(v);
  const res = await post(cfg.url.replace(/\/+$/, "") + "/chat/completions", headers, requestBody(cfg, messages, tools, opts.extra), keys, cfg.model, opts.signal);

  const msg: ModelMessage = { role: "assistant", content: "" };
  let reasoning = "";
  const calls: ToolCall[] = [];
  let finish = "stop";
  let usage: Record<string, unknown> | undefined;
  let emitted = false;
  const take = (chunk: Record<string, any>) => {
    if (chunk.error) throw new ModelError(`${cfg.model}: ${keys.mask(String(chunk.error.message ?? JSON.stringify(chunk.error)))}`, Number(chunk.error.code) || 0, emitted);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? choice.message ?? {};
    if (typeof d.content === "string" && d.content) { msg.content += d.content; emitted = true; opts.onDelta?.({ content: d.content }); }
    const rs = d.reasoning_content ?? d.reasoning;
    if (typeof rs === "string" && rs) { reasoning += rs; emitted = true; opts.onDelta?.({ reasoning: rs }); }
    for (const tc of d.tool_calls ?? []) {
      const i = typeof tc.index === "number" ? tc.index : calls.length;
      calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };
  try {
    if (!(res.headers.get("content-type") ?? "").includes("event-stream")) take(await res.json());   // an endpoint that ignored stream: true
    else for await (const ev of events(res)) {
      if (ev.data === "[DONE]") continue;
      let chunk: Record<string, any>;
      try { chunk = JSON.parse(ev.data); } catch { continue; }
      take(chunk);
    }
  } catch (e) {
    if (e instanceof ModelError || opts.signal?.aborted) throw e;
    throw new ModelError(`${cfg.model}: the answer broke off (${(e as Error).message})`, 0, emitted);
  }
  if (reasoning) msg.reasoning_content = reasoning;
  const real = calls.filter(Boolean).filter((c) => c.function.name);
  real.forEach((c, i) => { if (!c.id) c.id = `call_${Date.now().toString(36)}_${i}`; });
  if (real.length) msg.tool_calls = real;
  if (!msg.content) msg.content = real.length ? null : "";
  return { message: msg, finish, usage };
}

/** The island's messages in the Messages API's shape: the system text apart, tool calls and results as blocks, and
 *  turns alternating (consecutive messages of one side are joined). Reasoning isn't sent back: the API wants its own
 *  signatures on thinking blocks. */
export function toAnthropic(messages: ModelMessage[]) {
  const system: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];
  const push = (role: "user" | "assistant", blocks: Array<Record<string, unknown>>) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  messages.forEach((m, i) => {
    if (m.role === "system") {
      if (!out.length) system.push(m.content ?? "");
      else push("user", [{ type: "text", text: `[note] ${m.content ?? ""}` }]);
      return void i;
    }
    if (m.role === "user") push("user", [{ type: "text", text: m.content ?? "" }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" }]);
    else {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = {}; }
        blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input });
      }
      push("assistant", blocks.length ? blocks : [{ type: "text", text: "…" }]);
    }
  });
  return { system: system.join("\n\n"), messages: out };
}

async function anthropic(r: Resolved, keys: Keys, messages: ModelMessage[], tools: ToolSpec[], opts: Opts): Promise<Reply> {
  const cfg = r.cfg;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", "anthropic-version": "2023-06-01" };
  for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k.toLowerCase()] = keys.fill(v);
  const conv = toAnthropic(messages);
  const body: Record<string, unknown> = { max_tokens: 8192, ...(cfg.params ?? {}), ...(opts.extra ?? {}), model: cfg.model, messages: conv.messages, stream: true };
  if (conv.system) body.system = conv.system;
  if (tools.length) body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  for (const k of cfg.omit ?? SAMPLING.filter((s) => !(cfg.params && s in cfg.params))) delete body[k];
  const res = await post(cfg.url.replace(/\/+$/, "") + "/messages", headers, body, keys, cfg.model, opts.signal);

  const msg: ModelMessage = { role: "assistant", content: "" };
  let reasoning = "";
  const blocks: Array<{ type: string; id?: string; name?: string; json: string }> = [];
  let finish = "stop";
  let usage: Record<string, unknown> | undefined;
  let emitted = false;
  try {
    for await (const ev of events(res)) {
      let d: Record<string, any>;
      try { d = JSON.parse(ev.data); } catch { continue; }
      if (d.type === "error") throw new ModelError(`${cfg.model}: ${keys.mask(String(d.error?.message ?? "error"))}`, d.error?.type === "rate_limit_error" || d.error?.type === "overloaded_error" ? 429 : 0, emitted);
      if (d.type === "message_start" && d.message?.usage) usage = d.message.usage;
      if (d.type === "content_block_start") blocks[d.index] = { type: d.content_block?.type, id: d.content_block?.id, name: d.content_block?.name, json: "" };
      if (d.type === "content_block_delta") {
        const x = d.delta ?? {};
        if (x.type === "text_delta" && x.text) { msg.content += x.text; emitted = true; opts.onDelta?.({ content: x.text }); }
        else if (x.type === "thinking_delta" && x.thinking) { reasoning += x.thinking; emitted = true; opts.onDelta?.({ reasoning: x.thinking }); }
        else if (x.type === "input_json_delta" && blocks[d.index]) blocks[d.index].json += x.partial_json ?? "";
      }
      if (d.type === "message_delta") {
        const stop = d.delta?.stop_reason;
        if (stop) finish = stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : "stop";
        if (d.usage) usage = { ...(usage ?? {}), ...d.usage };
      }
    }
  } catch (e) {
    if (e instanceof ModelError || opts.signal?.aborted) throw e;
    throw new ModelError(`${cfg.model}: the answer broke off (${(e as Error).message})`, 0, emitted);
  }
  const calls = blocks.filter((b) => b && b.type === "tool_use").map((b, i) => ({ id: b.id ?? `call_${i}`, type: "function" as const, function: { name: b.name ?? "", arguments: b.json || "{}" } }));
  if (reasoning) msg.reasoning_content = reasoning;
  if (calls.length) msg.tool_calls = calls;
  if (!msg.content) msg.content = calls.length ? null : "";
  return { message: msg, finish, usage };
}
