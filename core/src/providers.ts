// Which model answers: resolving a model to its provider, the fallback chain, a model per purpose, and providers that
// are resting because they said they're out of their limit (state/providers.json, so a restart remembers).

import fs from "node:fs";
import path from "node:path";
import type { IslandConfig, ModelConfig } from "./config.ts";
import type { Keys } from "./keys.ts";
import type { Resolved } from "./models.ts";

export const DEFAULT_REST_MS = 15 * 60_000;

export type ProviderStatus = { name: string; wire: string; status: "ready" | "pending" | "needs-key" | "resting"; until?: number; reason?: string; note?: string };

export class Providers {
  private file: string;
  private rests: Record<string, { until: number; reason: string }> = {};
  private config: IslandConfig;
  private keys: Keys;

  constructor(stateDir: string, config: IslandConfig, keys: Keys) {
    this.file = path.join(stateDir, "providers.json");
    this.config = config;
    this.keys = keys;
    try { this.rests = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch {}
  }

  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.rests, null, 2));
  }

  /** The provider a model belongs to: its named one, or a provider of its own made from its url. */
  providerOf(name: string): string {
    const m = this.config.models.list[name];
    return m?.provider ?? `model:${name}`;
  }

  resolve(name: string): Resolved {
    const m: ModelConfig | undefined = this.config.models.list[name];
    if (!m) throw new Error(`no model called "${name}" in config/island.json`);
    const p = m.provider ? this.config.providers[m.provider] : undefined;
    if (m.provider && !p) throw new Error(`model "${name}" names a provider "${m.provider}" that isn't in config/island.json`);
    const url = m.url ?? p?.url;
    if (!url && p?.wire !== "aicord") throw new Error(`model "${name}" has no url, and neither has its provider`);
    return { name, provider: this.providerOf(name), wire: p?.wire ?? "openai", cfg: { ...m, url: url ?? "", headers: { ...(p?.headers ?? {}), ...(m.headers ?? {}) } } };
  }

  /** Is this model usable right now? If not, why. */
  check(name: string, now = Date.now()): { ok: true } | { ok: false; why: string; status: ProviderStatus["status"] } {
    let r: Resolved;
    try { r = this.resolve(name); } catch (e) { return { ok: false, why: (e as Error).message, status: "pending" }; }
    const p = this.config.models.list[name].provider ? this.config.providers[this.config.models.list[name].provider!] : undefined;
    if (p?.status === "pending" || r.wire === "aicord") return { ok: false, why: `${r.provider} is pending`, status: "pending" };
    const missing = Object.values(r.cfg.headers ?? {}).flatMap((v) => [...v.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((x) => x[1])).filter((k) => !this.keys.has(k));
    if (missing.length) return { ok: false, why: `${r.provider} needs the key ${missing.join(", ")}`, status: "needs-key" };
    const rest = this.rests[r.provider];
    if (rest && rest.until > now) return { ok: false, why: `${r.provider} is resting until ${new Date(rest.until).toISOString()} (${rest.reason})`, status: "resting" };
    return { ok: true };
  }

  rest(provider: string, until: number, reason: string) {
    this.rests[provider] = { until, reason: reason.slice(0, 200) };
    this.save();
  }

  /** The order to try: the one asked for (or the purpose's, or the default), then the fallbacks, each once. */
  chain(asked?: string, purpose?: string): string[] {
    const first = asked ?? (purpose ? this.config.models.roles?.[purpose] : undefined) ?? this.config.models.default;
    const out: string[] = [];
    for (const n of [first, ...(this.config.models.fallback ?? [])]) if (n && !out.includes(n)) out.push(n);
    return out;
  }

  list(now = Date.now()): ProviderStatus[] {
    const names = new Set<string>([...Object.keys(this.config.providers), ...Object.keys(this.config.models.list).filter((m) => !this.config.models.list[m].provider).map((m) => `model:${m}`)]);
    return [...names].map((name) => {
      const p = this.config.providers[name];
      const wire = p?.wire ?? "openai";
      const model = Object.keys(this.config.models.list).find((m) => this.providerOf(m) === name);
      const c = model ? this.check(model, now) : p?.status === "pending" || wire === "aicord" ? { ok: false as const, why: "pending", status: "pending" as const } : { ok: true as const };
      const rest = this.rests[name];
      return { name, wire, status: c.ok ? "ready" : c.status, ...(rest && rest.until > now ? { until: rest.until, reason: rest.reason } : {}), ...(p?.note ? { note: p.note } : {}) };
    });
  }
}
