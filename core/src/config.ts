// The island's settings: config/island.json in its home. Everything has a sensible default, so a new island runs
// with an empty file. Key values never live here: a setting names a key (`{{NAME}}`), and the keystore fills it in.

import fs from "node:fs";
import path from "node:path";

/** Where models come from, and how to talk to them. */
export interface ProviderConfig {
  /** "openai": Chat Completions (Ollama, Ollama Cloud, OpenAI, xAI, Groq, llama.cpp, Moonshot, Shapes …);
   *  "anthropic": the Messages API; "aicord": not built yet (see docs/config.md) */
  wire: "openai" | "anthropic" | "aicord";
  /** Up to and including the version part: http://localhost:11434/v1, https://api.anthropic.com/v1 */
  url?: string;
  /** Values may name keys: { "Authorization": "Bearer {{OPENAI_API_KEY}}" } */
  headers?: Record<string, string>;
  /** "pending": listed but not used yet */
  status?: "pending";
  note?: string;
}

export interface ModelConfig {
  /** A provider from `providers`; its url and headers are used unless the model sets its own */
  provider?: string;
  /** An OpenAI-compatible endpoint, up to and including /v1 (Ollama: http://localhost:11434/v1) */
  url?: string;
  model: string;
  /** Extra headers; values may name keys: { "Authorization": "Bearer {{MOONSHOT_API_KEY}}" } */
  headers?: Record<string, string>;
  /** Extra body fields sent with every request: { "reasoning_effort": "high", "prompt_cache_options": { "ttl": "5m" } } */
  params?: Record<string, unknown>;
  /** Body fields never to send, even if a caller asks (settings the model fixes) */
  omit?: string[];
  /** Keep the model's reasoning in the chat and send it back in later turns (some models ask for the whole message) */
  keepReasoning?: boolean;
}

export interface McpConfig {
  command: string;
  args?: string[];
  /** Values may name keys: { "BRAVE_API_KEY": "{{BRAVE_API_KEY}}" } */
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface IslandConfig {
  /** Who the island is, in its own events and messages */
  self: string;
  providers: Record<string, ProviderConfig>;
  models: {
    default: string;
    /** Tried in order when the one asked for can't answer (it's down, out of its limit, or refuses) */
    fallback?: string[];
    /** A model per purpose: { "heartbeat": "kitti", "schedules": "k27" } */
    roles?: Record<string, string>;
    list: Record<string, ModelConfig>;
  };
  /** The heartbeat: off unless `every` is set. It reads `file` (her checklist) each time. */
  heartbeat?: { every?: string; model?: string; file?: string; prompt?: string };
  /** Vault files that make up her system prompt, in order; missing ones are skipped */
  system: string[];
  /** Tools whose answer is added to the system prompt at the start of each turn (the mode shrine's mode_get) */
  context: string[];
  memoryFile: string;
  journalDir: string;
  /** Tool calls in one turn before it stops and says so */
  maxSteps: number;
  shell: { command?: string; timeoutMs: number; maxOutput: number };
  mcp: Record<string, McpConfig>;
  /** Where keys are kept: "dpapi" (Windows, sealed to the island's account) or "file" (elsewhere, owner-only files) */
  keystore: "dpapi" | "file";
}

export const DEFAULTS: IslandConfig = {
  self: "pandora",
  providers: {},
  models: { default: "local", list: { local: { url: "http://localhost:11434/v1", model: "qwen3:8b" } } },
  system: ["/Pandora/SOUL.md", "/Pandora/AGENTS.md", "/Pandora/SYSTEM.md", "/Pandora/Memory.md"],
  context: [],
  memoryFile: "/Pandora/Memory.md",
  journalDir: "/Pandora/Journal",
  maxSteps: 40,
  shell: { timeoutMs: 120_000, maxOutput: 50_000 },
  mcp: {},
  keystore: process.platform === "win32" ? "dpapi" : "file",
};

export function loadConfig(configDir: string): IslandConfig {
  const file = path.join(configDir, "island.json");
  let raw: Partial<IslandConfig> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`config/island.json can't be read: ${(e as Error).message}`);
  }
  return {
    ...DEFAULTS,
    ...raw,
    models: { ...DEFAULTS.models, ...(raw.models ?? {}), list: { ...(raw.models?.list ?? DEFAULTS.models.list) } },
    shell: { ...DEFAULTS.shell, ...(raw.shell ?? {}) },
    providers: raw.providers ?? {},
    mcp: raw.mcp ?? {},
  };
}
