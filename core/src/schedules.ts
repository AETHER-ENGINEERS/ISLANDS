// Her schedules and her heartbeat, run by the island as threads, so they keep their time when no window is open.
//
// A schedule says when (`every 30m`, `every 2h`, `daily 08:30`, `weekdays 09:00`, `weekends 10:00`, or 5-field cron)
// and what: a prompt (a turn of hers in the schedule's own chat) or a shell command. Schedules live in
// config/schedules.json. A run missed while the island was down is caught up once, not once per miss, and a schedule
// never runs over itself. The heartbeat is a schedule from config/island.json (`heartbeat.every`), off until it's set;
// it reads her checklist (HEARTBEAT.md) fresh each time.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Island } from "./island.ts";
import { runTurn } from "./agent.ts";
import { badParams, notFound } from "./errors.ts";

// ---------- when ----------

export interface Cron { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

function field(text: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`"${part}" isn't a cron field`);
    let a = lo, b = hi;
    if (m[2] !== undefined) { a = Number(m[2]); b = m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a; }
    const step = m[4] ? Number(m[4]) : 1;
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`"${part}" is out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Plain words or 5-field cron, as cron. */
export function parseWhen(when: string): { cron: Cron; text: string } {
  const w = String(when ?? "").trim().toLowerCase();
  let expr: string | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^every\s+(\d+)\s*(m|min|mins|minutes?)$/.exec(w))) {
    const n = Number(m[1]);
    if (n < 1 || n > 59 || 60 % n) throw new Error("every N minutes: N must divide 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)");
    expr = `*/${n} * * * *`;
  } else if ((m = /^every\s+(\d+)\s*(h|hr|hrs|hours?)$/.exec(w))) {
    const n = Number(m[1]);
    if (n < 1 || n > 23 || 24 % n) throw new Error("every N hours: N must divide 24 (1, 2, 3, 4, 6, 8, 12)");
    expr = `0 */${n} * * *`;
  } else if ((m = /^(daily|every day|weekdays|weekends)\s+(?:at\s+)?(\d{1,2}):(\d{2})$/.exec(w))) {
    const days = m[1] === "weekdays" ? "1-5" : m[1] === "weekends" ? "0,6" : "*";
    expr = `${Number(m[3])} ${Number(m[2])} * * ${days}`;
  } else if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(w)) expr = w;
  if (!expr) throw new Error(`"${when}" isn't a time I understand: try every 30m, every 2h, daily 08:30, weekdays 09:00, or 5-field cron`);
  const [mi, h, d, mo, dw] = expr.split(/\s+/);
  const dow = field(dw.replace(/\b7\b/g, "0"), 0, 6);
  return { cron: { min: field(mi, 0, 59), hour: field(h, 0, 23), dom: field(d, 1, 31), mon: field(mo, 1, 12), dow, domAny: d === "*", dowAny: dw === "*" }, text: expr };
}

const matches = (c: Cron, t: Date) => {
  if (!c.min.has(t.getMinutes()) || !c.hour.has(t.getHours()) || !c.mon.has(t.getMonth() + 1)) return false;
  const dom = c.dom.has(t.getDate()), dow = c.dow.has(t.getDay());
  return c.domAny && c.dowAny ? true : c.domAny ? dow : c.dowAny ? dom : dom || dow;   // cron's rule: either day field
};

/** The first matching minute after `after` (local time). */
export function nextAfter(c: Cron, after: Date): Date {
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(c, t)) return t;
    if (!c.hour.has(t.getHours())) { t.setMinutes(0); t.setHours(t.getHours() + 1); continue; }
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error("that schedule never comes round");
}

// ---------- schedules ----------

export interface Schedule {
  id: string;
  name: string;
  when: string;
  prompt?: string;
  command?: string;
  model?: string;
  chat?: string;
  enabled: boolean;
  created: string;
  lastRun?: string;
  lastStatus?: string;
}

export const HEARTBEAT = "heartbeat";
const DEFAULT_HEARTBEAT = "This is your heartbeat. Here is your checklist from {file}:\n\n{checklist}\n\nWork through it now. Write what matters in your journal. Use notify only when something truly needs your person's attention.";

export class Scheduler {
  private island: Island;
  private file: string;
  private stateFile: string;
  private timer: NodeJS.Timeout | null = null;
  private runningIds = new Map<string, string>();   // schedule id → thread id

  constructor(island: Island) {
    this.island = island;
    this.file = path.join(island.dirs.config, "schedules.json");
    this.stateFile = path.join(island.dirs.state, "heartbeat.json");
  }

  private read(): Schedule[] {
    try { const l = JSON.parse(fs.readFileSync(this.file, "utf8")); return Array.isArray(l) ? l : []; } catch { return []; }
  }
  private write(list: Schedule[]) {
    const tmp = this.file + ".new";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** The heartbeat as a schedule (from config/island.json), or none when it isn't switched on. */
  heartbeat(): Schedule | null {
    const hb = this.island.config.heartbeat;
    if (!hb?.every) return null;
    let st: Partial<Schedule> = {};
    try { st = JSON.parse(fs.readFileSync(this.stateFile, "utf8")); } catch {}
    return { id: HEARTBEAT, name: "Heartbeat", when: hb.every, model: hb.model, chat: st.chat, enabled: true, created: st.created ?? this.island.startedAt, lastRun: st.lastRun, lastStatus: st.lastStatus };
  }
  private saveHeartbeat(s: Schedule) {
    fs.writeFileSync(this.stateFile, JSON.stringify({ chat: s.chat, created: s.created, lastRun: s.lastRun, lastStatus: s.lastStatus }, null, 2));
  }

  all(): Schedule[] {
    const hb = this.heartbeat();
    return [...(hb ? [hb] : []), ...this.read()];
  }

  list() {
    return this.all().map((s) => {
      let next: string | undefined;
      try { if (s.enabled) next = nextAfter(parseWhen(s.when).cron, new Date(Date.parse(s.lastRun ?? s.created))).toISOString(); } catch {}
      return { ...s, next, running: this.runningIds.get(s.id) };
    });
  }

  private check(p: Partial<Schedule>) {
    if (p.when !== undefined) try { parseWhen(p.when); } catch (e) { throw badParams((e as Error).message); }
    if (p.model !== undefined && !this.island.config.models.list[p.model]) throw badParams(`no model called ${p.model}`);
  }

  create(p: Record<string, unknown>, actor: string, via: string): Schedule {
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 100) : "";
    if (!name) throw badParams("a schedule needs a name");
    if (typeof p.when !== "string") throw badParams("when is text, e.g. daily 08:30");
    const prompt = typeof p.prompt === "string" && p.prompt.trim() ? p.prompt : undefined;
    const command = typeof p.command === "string" && p.command.trim() ? p.command : undefined;
    if (!prompt === !command) throw badParams("give a prompt or a command (one of them)");
    const s: Schedule = { id: `sch-${crypto.randomBytes(4).toString("hex")}`, name, when: p.when, prompt, command, model: typeof p.model === "string" ? p.model : undefined, enabled: p.enabled !== false, created: new Date().toISOString() };
    this.check(s);
    this.write([...this.read(), s]);
    this.island.log.append({ actor, via, kind: "schedule.create", schedule: s.id, when: s.when });
    return s;
  }

  update(id: string, p: Record<string, unknown>, actor: string, via: string): Schedule {
    if (id === HEARTBEAT) throw badParams("the heartbeat is set in config/island.json");
    const list = this.read();
    const s = list.find((x) => x.id === id);
    if (!s) throw notFound(`schedule ${id}`);
    const next: Schedule = { ...s };
    if (typeof p.name === "string") next.name = p.name.trim().slice(0, 100) || s.name;
    if (typeof p.when === "string") next.when = p.when;
    if (typeof p.prompt === "string") { next.prompt = p.prompt; delete next.command; }
    if (typeof p.command === "string") { next.command = p.command; delete next.prompt; }
    if (typeof p.model === "string") next.model = p.model;
    if (typeof p.enabled === "boolean") next.enabled = p.enabled;
    this.check(next);
    this.write(list.map((x) => (x.id === id ? next : x)));
    this.island.log.append({ actor, via, kind: "schedule.update", schedule: id, enabled: next.enabled });
    return next;
  }

  delete(id: string, actor: string, via: string) {
    if (id === HEARTBEAT) throw badParams("the heartbeat is switched off in config/island.json");
    const list = this.read();
    if (!list.some((x) => x.id === id)) throw notFound(`schedule ${id}`);
    this.write(list.filter((x) => x.id !== id));
    this.island.log.append({ actor, via, kind: "schedule.delete", schedule: id });
    return { id };
  }

  /** Run every schedule that's due at `now` (the minute timer calls this; tests call it with a time). */
  tick(now = new Date()) {
    const started: string[] = [];
    for (const s of this.all()) {
      if (!s.enabled) continue;
      let due: Date;
      try { due = nextAfter(parseWhen(s.when).cron, new Date(Date.parse(s.lastRun ?? s.created))); } catch { continue; }
      if (due.getTime() <= now.getTime()) { const t = this.run(s.id, "scheduler", "schedule", now); if (t) started.push(t); }
    }
    return started;
  }

  /** Run one schedule now. Returns its thread id, or nothing if it's still running from last time. */
  run(id: string, actor = "scheduler", via = "schedule", now = new Date()): string | undefined {
    const s = this.all().find((x) => x.id === id);
    if (!s) throw notFound(`schedule ${id}`);
    const island = this.island;
    const save = (patch: Partial<Schedule>) => {
      Object.assign(s, patch);
      if (s.id === HEARTBEAT) this.saveHeartbeat(s);
      else this.write(this.read().map((x) => (x.id === s.id ? { ...x, ...patch } : x)));
    };
    if (this.runningIds.has(s.id)) {
      island.log.append({ actor, via, kind: "schedule.skip", schedule: s.id, why: "still running" });
      return undefined;
    }
    save({ lastRun: now.toISOString() });   // a run missed while the island was down is caught up once, not per miss

    let prompt = s.prompt;
    if (s.id === HEARTBEAT) {
      const hb = island.config.heartbeat ?? {};
      const file = hb.file ?? "/Pandora/HEARTBEAT.md";
      let checklist = "";
      try { checklist = island.vault.read(file).data.toString("utf8"); } catch {}
      if (!checklist.trim()) { save({ lastStatus: `skipped: ${file} is missing or empty` }); island.log.append({ actor, via, kind: "schedule.skip", schedule: s.id, why: "no checklist" }); return undefined; }
      prompt = (hb.prompt ?? DEFAULT_HEARTBEAT).replace("{file}", file).replace("{checklist}", checklist);
    }
    if (!s.chat || !fs.existsSync(path.join(island.dirs.chats, `${s.chat}.jsonl`))) save({ chat: island.chats.create(`⏰ ${s.name}`, island.config.self, `schedule:${s.id}`).id });
    const chat = s.chat!;
    const by = `schedule:${s.id}`;
    const t = island.threads.start({ kind: "schedule", title: s.name, chat, by: island.config.self, via: by }, async (ctx) => {
      try {
        if (prompt) {
          island.chats.post(chat, "user", island.keys.mask(prompt), by, by);
          await runTurn(island, chat, { model: s.model, purpose: s.id === HEARTBEAT ? "heartbeat" : "schedules" }, ctx);
        } else {
          const shell = (await island.tools()).find((x) => x.name === "shell")!;
          const out = await shell.run({ command: s.command! }, { signal: ctx.signal, actor: island.config.self, via: by });
          island.chats.post(chat, "system", `$ ${s.command}\n${out}`, by, by);
        }
        save({ lastStatus: "done" });
      } catch (e) {
        save({ lastStatus: `failed: ${(e as Error).message}`.slice(0, 300) });
        throw e;
      } finally {
        this.runningIds.delete(s.id);
      }
    });
    this.runningIds.set(s.id, t.id);
    return t.id;
  }

  start() {
    if (this.timer) return;
    const loop = () => {
      try { this.tick(); } catch (e) { console.error("scheduler:", (e as Error).message); }
      const now = new Date();
      this.timer = setTimeout(loop, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
