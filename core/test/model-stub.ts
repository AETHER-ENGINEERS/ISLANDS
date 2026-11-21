// A stand-in for an OpenAI-compatible model endpoint: streams scripted replies (text, reasoning, tool calls) the way
// real ones do, and keeps every request it got, so the tests can check what the island sent.
import http from "node:http";

type Plain = { text?: string; reasoning?: string; tools?: Array<{ name: string; args: Record<string, unknown> }>; slowMs?: number; fail?: number; retryAfter?: number; message?: string };
export type Step = Plain | ((body: any) => Plain);

export async function modelStub(script: Step[]) {
  const requests: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ headers: req.headers, body });
      const step0 = script[Math.min(i++, script.length - 1)];
      const step = typeof step0 === "function" ? step0(body) : step0;
      if (step.fail) {
        res.writeHead(step.fail, { "content-type": "application/json", ...(step.retryAfter ? { "retry-after": String(step.retryAfter) } : {}) });
        return res.end(JSON.stringify({ error: { message: step.message ?? "you've reached your session limit" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      if (step.reasoning) for (const part of step.reasoning.match(/.{1,8}/gs) ?? []) send({ reasoning_content: part });
      if (step.text) for (const part of step.text.match(/.{1,6}/gs) ?? []) { send({ content: part }); if (step.slowMs) await pause(step.slowMs); if (res.destroyed) return; }
      (step.tools ?? []).forEach((t, n) => {
        const args = JSON.stringify(t.args);
        send({ tool_calls: [{ index: n, id: `call_${i}_${n}`, type: "function", function: { name: t.name, arguments: args.slice(0, 5) } }] });
        send({ tool_calls: [{ index: n, function: { arguments: args.slice(5) } }] });
      });
      send({}, step.tools?.length ? "tool_calls" : "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
