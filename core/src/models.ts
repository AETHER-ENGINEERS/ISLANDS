// Talking to a model: any OpenAI-compatible chat endpoint (Ollama, Ollama Cloud, Groq, llama.cpp, Moonshot …),
// streamed. Per-model settings ride along (reasoning_effort, prompt_cache_options), settings a model fixes are never
// sent, and the whole assistant message (its reasoning and tool calls too) comes back to be kept in the chat.

import type { ModelConfig } from "./config.ts";
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

/** Sampling settings that are never sent unless a model's own params name them (some models fix them and refuse). */
const SAMPLING = ["temperature", "top_p", "n", "presence_penalty", "frequency_penalty"];

export function requestBody(cfg: ModelConfig, messages: ModelMessage[], tools: ToolSpec[], extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = { ...(cfg.params ?? {}), ...extra, model: cfg.model, messages, stream: true };
  if (tools.length) body.tools = tools;
  for (const k of cfg.omit ?? SAMPLING.filter((s) => !(cfg.params && s in cfg.params))) delete body[k];
  return body;
}

/**
 * One call to the model, streamed. `onDelta` hears text and reasoning as they arrive. The result is the whole message.
 */
export async function complete(
  cfg: ModelConfig,
  keys: Keys,
  messages: ModelMessage[],
  tools: ToolSpec[],
  opts: { extra?: Record<string, unknown>; signal?: AbortSignal; onDelta?: (d: { content?: string; reasoning?: string }) => void } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = keys.fill(v);
  const url = cfg.url.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(requestBody(cfg, messages, tools, opts.extra)), signal: opts.signal });
  if (!res.ok || !res.body) {
    const text = keys.mask(await res.text().catch(() => ""));
    throw new Error(`${cfg.model} at ${new URL(url).host} answered ${res.status}: ${text.slice(0, 600)}`);
  }

  const msg: ModelMessage = { role: "assistant", content: "" };
  let reasoning = "";
  const calls: ToolCall[] = [];
  let finish = "stop";
  let usage: Record<string, unknown> | undefined;
  const take = (chunk: Record<string, any>) => {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? choice.message ?? {};
    if (typeof d.content === "string" && d.content) { msg.content += d.content; opts.onDelta?.({ content: d.content }); }
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === "string" && r) { reasoning += r; opts.onDelta?.({ reasoning: r }); }
    for (const tc of d.tool_calls ?? []) {
      const i = typeof tc.index === "number" ? tc.index : calls.length;
      calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("event-stream")) take(await res.json());   // an endpoint that ignored stream: true
  else {
    const dec = new TextDecoder();
    let buf = "";
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(part, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try { take(JSON.parse(data)); } catch {}
      }
    }
  }
  if (reasoning) msg.reasoning_content = reasoning;
  const real = calls.filter(Boolean).filter((c) => c.function.name);
  real.forEach((c, i) => { if (!c.id) c.id = `call_${Date.now().toString(36)}_${i}`; });
  if (real.length) msg.tool_calls = real;
  if (!msg.content) msg.content = real.length ? null : "";
  return { message: msg, finish, usage };
}
