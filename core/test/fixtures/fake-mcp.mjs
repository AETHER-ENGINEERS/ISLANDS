// A small stdio MCP server for the tests, shaped like the mode shrine: one JSON-RPC message per line.
let mode = "snack";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
    const text = (t, isError = false) => reply({ content: [{ type: "text", text: t }], isError });
    if (req.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
    else if (req.method === "notifications/initialized") {}
    else if (req.method === "tools/list") reply({ tools: [
      { name: "mode_get", description: "Get the current mode.", inputSchema: { type: "object", properties: {} } },
      { name: "mode_set", description: "Set the mode.", inputSchema: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] } },
      { name: "echo_secret", description: "Says the secret it was given (to test masking).", inputSchema: { type: "object", properties: {} } },
      { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
    ] });
    else if (req.method === "tools/call") {
      const n = req.params.name;
      if (n === "mode_get") text(JSON.stringify({ mode, emoji: mode === "forge" ? "🔥" : "🍪" }));
      else if (n === "mode_set") { mode = req.params.arguments.mode; text(JSON.stringify({ mode })); }
      else if (n === "echo_secret") text(`the secret is ${process.env.FAKE_SECRET}`);
      else if (n === "fail") text("it went wrong", true);
      else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no such tool" } }) + "\n");
    }
  }
});
