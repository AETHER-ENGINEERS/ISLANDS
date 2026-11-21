// The core's door: JSON-RPC 2.0, one message per line, on a private named pipe (Windows) or Unix socket. The harbor
// (the island's .NET service host) is what ferries reach; it passes their connections through to here. The endpoint
// and its token are written to state/core.json, inside the island's home, and removed when the core stops.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Island, Session } from "./island.ts";
import { IslandError, CODES } from "./errors.ts";

export const MAX_LINE = 64 * 1024 * 1024;
export const HELLO_WITHIN = 10_000;

export function defaultEndpoint(stateDir: string) {
  return process.platform === "win32" ? `\\\\.\\pipe\\island-core-${crypto.randomBytes(8).toString("hex")}` : path.join(stateDir, "core.sock");
}

/** Serve one ferry's connection. */
export function serveConnection(island: Island, sock: net.Socket) {
  sock.setEncoding("utf8");
  let buf = "";
  let closed = false;
  const send = (o: unknown) => { if (!closed && !sock.destroyed) sock.write(JSON.stringify(o) + "\n"); };
  const s: Session = island.open((method, params) => send({ jsonrpc: "2.0", method, params }));
  const helloTimer = setTimeout(() => { if (!s.hello) sock.destroy(); }, HELLO_WITHIN);
  // requests on one connection are answered in the order they came
  let chain = Promise.resolve();

  const handle = async (line: string) => {
    let msg: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: CODES.parse, message: "that line isn't JSON" } }); }
    const id = msg && (typeof msg.id === "number" || typeof msg.id === "string") ? msg.id : null;
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return send({ jsonrpc: "2.0", id, error: { code: CODES.invalidRequest, message: "not a JSON-RPC 2.0 request" } });
    try {
      const result = await island.call(msg.method, msg.params, s);
      if (id !== null) send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (e) {
      const code = e instanceof IslandError ? e.code : CODES.internal;
      if (id !== null) send({ jsonrpc: "2.0", id, error: { code, message: e instanceof Error ? e.message : String(e) } });
      if (code === CODES.noHello && msg.method === "island.hello") setTimeout(() => sock.destroy(), 50);
    }
  };

  sock.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes("\n")) {
      send({ jsonrpc: "2.0", id: null, error: { code: CODES.invalidRequest, message: "that line is too long" } });
      sock.destroy();
      return;
    }
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) chain = chain.then(() => handle(line));
    }
  });
  const end = () => { if (closed) return; closed = true; clearTimeout(helloTimer); island.close(s); };
  sock.on("close", end);
  sock.on("error", end);
}

export interface Listening {
  endpoint: string;
  close: () => Promise<void>;
}

/** Open the core's door and write state/core.json. */
export function listen(island: Island, endpoint = defaultEndpoint(island.dirs.state)): Promise<Listening> {
  if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });   // a socket left by a core that fell over
  const socks = new Set<net.Socket>();
  const server = net.createServer((sock) => { socks.add(sock); sock.on("close", () => socks.delete(sock)); serveConnection(island, sock); });
  const info = path.join(island.dirs.state, "core.json");
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
      fs.writeFileSync(info, JSON.stringify({ endpoint, token: island.token, pid: process.pid, startedAt: island.startedAt }, null, 2), { mode: 0o600 });
      resolve({
        endpoint,
        close: () => new Promise<void>((r) => {
          for (const s of [...island.sessions]) s.stop?.();
          try { fs.rmSync(info, { force: true }); } catch {}
          server.close(() => r());
          for (const sock of socks) sock.destroy();   // connections still open end too, so close() finishes
        }),
      });
    });
  });
}
