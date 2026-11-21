// The thread manager: long work (a turn of hers, a tool, a shell command) belongs to the island, not to the window
// that asked for it. A ferry can close, come back or switch chats; the thread keeps going, its record stays in runs/,
// and its start and end are in the log for whoever catches up. Any ferry can watch one or stop one.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { EventLog } from "./log.ts";
import { notFound } from "./errors.ts";

export type ThreadStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";
export interface ThreadRecord {
  id: string;
  kind: string;
  title: string;
  chat?: string;
  by: string;
  via: string;
  status: ThreadStatus;
  started: string;
  ended?: string;
  error?: string;
  progress?: string;
}
export interface ThreadContext {
  id: string;
  signal: AbortSignal;
  progress: (text: string) => void;
}

export class Threads {
  readonly dir: string;
  readonly log: EventLog;
  private live = new Map<string, { rec: ThreadRecord; abort: AbortController; done: Promise<void> }>();
  private notify: (method: string, params: unknown) => void;

  constructor(dir: string, log: EventLog, notify: (method: string, params: unknown) => void) {
    this.dir = path.resolve(dir);
    this.log = log;
    this.notify = notify;
    fs.mkdirSync(this.dir, { recursive: true });
    // threads that were running when the island last stopped didn't finish: say so, once
    for (const rec of this.records()) {
      if (rec.status !== "running") continue;
      rec.status = "interrupted";
      rec.ended = new Date().toISOString();
      this.save(rec);
      this.log.append({ actor: rec.by, via: "core", kind: "thread.end", thread: rec.id, status: "interrupted" });
    }
  }

  private fileOf(id: string) {
    return path.join(this.dir, `${id}.json`);
  }
  private save(rec: ThreadRecord) {
    const tmp = this.fileOf(rec.id) + ".new";
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, this.fileOf(rec.id));
  }
  private records(): ThreadRecord[] {
    const out: ThreadRecord[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"))); } catch {}
    }
    return out;
  }

  /** Start work as an island thread. Returns at once; the work runs on. */
  start(info: { kind: string; title: string; chat?: string; by: string; via: string }, work: (ctx: ThreadContext) => Promise<void>): ThreadRecord {
    const rec: ThreadRecord = { id: `${info.kind}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`, ...info, status: "running", started: new Date().toISOString() };
    const abort = new AbortController();
    this.save(rec);
    this.log.append({ actor: info.by, via: info.via, kind: "thread.start", thread: rec.id, what: info.kind, chat: info.chat });
    this.notify("thread", { ...rec });
    let lastSaved = 0;
    const ctx: ThreadContext = {
      id: rec.id,
      signal: abort.signal,
      progress: (text) => {
        rec.progress = text.slice(0, 500);
        this.notify("thread", { ...rec });
        if (Date.now() - lastSaved > 2000) { lastSaved = Date.now(); this.save(rec); }
      },
    };
    const done = (async () => {
      try {
        await work(ctx);
        rec.status = abort.signal.aborted ? "cancelled" : "done";
      } catch (e) {
        rec.status = abort.signal.aborted ? "cancelled" : "failed";
        if (!abort.signal.aborted) rec.error = e instanceof Error ? e.message : String(e);
      }
      rec.ended = new Date().toISOString();
      this.save(rec);
      this.live.delete(rec.id);
      this.log.append({ actor: info.by, via: info.via, kind: "thread.end", thread: rec.id, status: rec.status, ms: Date.parse(rec.ended) - Date.parse(rec.started) });
      this.notify("thread", { ...rec });
    })();
    this.live.set(rec.id, { rec, abort, done });
    return { ...rec };
  }

  get(id: string): ThreadRecord {
    const l = this.live.get(id);
    if (l) return { ...l.rec };
    try { return JSON.parse(fs.readFileSync(this.fileOf(String(id).replace(/[^\w-]/g, "")), "utf8")); } catch { throw notFound(`thread ${id}`); }
  }

  list(limit = 50): ThreadRecord[] {
    return this.records().sort((a, b) => (a.started < b.started ? 1 : -1)).slice(0, limit);
  }

  running(chat?: string) {
    return [...this.live.values()].map((l) => l.rec).filter((r) => chat === undefined || r.chat === chat);
  }

  cancel(id: string) {
    const l = this.live.get(id);
    if (!l) { const r = this.get(id); return r; }
    l.abort.abort();
    return { ...l.rec };
  }

  /** Wait for a thread to finish (tests, shutdown). */
  async settle(id?: string) {
    const all = id ? [this.live.get(id)].filter(Boolean) : [...this.live.values()];
    await Promise.all(all.map((l) => l!.done));
  }
}
