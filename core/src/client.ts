// A small client for the ferry protocol, for Node ferries, tools and tests. (The WPF ferry has its own, in C#.)

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class Ferry extends EventEmitter {
  private sock: net.Socket;
  private next = 1;
  private waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
  private buf = "";

  private constructor(sock: net.Socket) {
    super();
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.id !== undefined && m.id !== null && this.waiting.has(m.id)) {
          const w = this.waiting.get(m.id)!;
          this.waiting.delete(m.id);
          if (m.error) w.no(new RpcError(m.error.code, m.error.message));
          else w.ok(m.result);
        } else if (m.method) this.emit(m.method, m.params);
        else if (m.error) this.emit("rpc-error", new RpcError(m.error.code, m.error.message));
      }
    });
    const fail = () => { for (const w of this.waiting.values()) w.no(new Error("the island closed the connection")); this.waiting.clear(); this.emit("close"); };
    sock.on("close", fail);
    sock.on("error", () => {});
  }

  static connect(endpoint: string): Promise<Ferry> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(endpoint, () => resolve(new Ferry(sock)));
      sock.once("error", reject);
    });
  }

  /** Read state/core.json in an island's home, connect, and say hello. */
  static async toHome(home: string, ferry = { name: "node", version: "0" }, as = "someone"): Promise<{ ferry: Ferry; hello: { seq: number } }> {
    const info = JSON.parse(fs.readFileSync(path.join(home, "state", "core.json"), "utf8"));
    const f = await Ferry.connect(info.endpoint);
    const hello = (await f.call("island.hello", { token: info.token, ferry, protocol: "islands/0.1", as })) as { seq: number };
    return { ferry: f, hello };
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++;
    return new Promise((ok, no) => {
      this.waiting.set(id, { ok, no });
      this.sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Send raw text (for tests). */
  raw(text: string) {
    this.sock.write(text);
  }

  close() {
    this.sock.end();
  }
}
