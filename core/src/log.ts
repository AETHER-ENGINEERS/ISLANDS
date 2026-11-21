// The island's event log: append-only, one JSON event per line, in numbered segment files (log/00000001.jsonl, …).
// Facts only, never content: who did what, when, through which ferry or tool, and the fingerprint of what changed.
// Every event gets the next `seq`; a ferry that comes back asks for everything after the last one it saw.

import fs from "node:fs";
import path from "node:path";

export interface IslandEvent {
  seq: number;
  at: string;
  actor: string;
  via?: string;
  kind: string;
  [field: string]: unknown;
}
export type NewEvent = Omit<IslandEvent, "seq" | "at">;
type Listener = (e: IslandEvent) => void;

const SEGMENT = /^(\d{8})\.jsonl$/;

export class EventLog {
  readonly dir: string;
  readonly maxSegment: number;
  private seq = 0;
  private segment = 1;
  private segmentBytes = 0;
  private listeners = new Set<Listener>();

  constructor(dir: string, { maxSegment = 16 * 1024 * 1024 } = {}) {
    this.dir = path.resolve(dir);
    this.maxSegment = maxSegment;
    fs.mkdirSync(this.dir, { recursive: true });
    const segs = this.segments();
    if (segs.length) {
      this.segment = segs[segs.length - 1];
      const file = this.fileOf(this.segment);
      const text = fs.readFileSync(file, "utf8");
      this.segmentBytes = Buffer.byteLength(text);
      // the last whole line holds the last seq; a line cut short by a crash is set aside, not trusted
      const lines = text.split("\n");
      if (lines[lines.length - 1] !== "") {
        const cut = lines.pop()!;
        fs.appendFileSync(path.join(this.dir, "cut-lines.txt"), `${new Date().toISOString()} ${path.basename(file)}: ${cut}\n`);
        const keep = lines.length ? lines.join("\n") + "\n" : "";
        fs.writeFileSync(file, keep);
        this.segmentBytes = Buffer.byteLength(keep);
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        try { this.seq = JSON.parse(lines[i]).seq; break; } catch {}
      }
      if (!this.seq && segs.length > 1) this.seq = this.lastSeqBefore(this.segment);
    }
  }

  private fileOf(n: number) {
    return path.join(this.dir, `${String(n).padStart(8, "0")}.jsonl`);
  }
  private segments() {
    return fs.readdirSync(this.dir).map((f) => SEGMENT.exec(f)).filter(Boolean).map((m) => Number(m![1])).sort((a, b) => a - b);
  }
  private lastSeqBefore(n: number) {
    for (const s of this.segments().filter((x) => x < n).reverse()) {
      const lines = fs.readFileSync(this.fileOf(s), "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]).seq as number; } catch {} }
    }
    return 0;
  }

  get last() {
    return this.seq;
  }

  /** Add an event. It is on disk before anyone hears about it. */
  append(e: NewEvent): IslandEvent {
    const ev = { seq: this.seq + 1, at: new Date().toISOString(), ...e } as IslandEvent;
    const line = JSON.stringify(ev) + "\n";
    if (this.segmentBytes > 0 && this.segmentBytes + Buffer.byteLength(line) > this.maxSegment) {
      this.segment++;
      this.segmentBytes = 0;
    }
    fs.appendFileSync(this.fileOf(this.segment), line);
    this.segmentBytes += Buffer.byteLength(line);
    this.seq = ev.seq;
    for (const f of this.listeners) {
      try { f(ev); } catch {}
    }
    return ev;
  }

  /** Events after `fromSeq`, oldest first, whose kind starts with one of `kinds` (all when none are given). */
  since(fromSeq = 0, { limit = Infinity, kinds }: { limit?: number; kinds?: string[] } = {}): { events: IslandEvent[]; more: boolean } {
    const match = (k: string) => !kinds?.length || kinds.some((p) => k.startsWith(p));
    const out: IslandEvent[] = [];
    for (const s of this.segments()) {
      const text = fs.readFileSync(this.fileOf(s), "utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        let ev: IslandEvent;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.seq <= fromSeq || !match(ev.kind)) continue;
        if (out.length >= limit) return { events: out, more: true };
        out.push(ev);
      }
    }
    return { events: out, more: false };
  }

  listen(f: Listener) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
}
