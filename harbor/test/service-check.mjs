// After install.ps1 (in CI, as administrator): the island runs as its own virtual account, and a person named in
// -Person can come in through the front door and say hello. Usage: node harbor/test/service-check.mjs <home> <pipe> <service>
import fs from "node:fs";
import path from "node:path";
import { Ferry } from "../../core/src/client.ts";

const [home, pipe, service] = process.argv.slice(2);
const fail = (m) => { console.error("FAIL " + m); process.exit(1); };
const hb = JSON.parse(fs.readFileSync(path.join(home, "state", "harbor.json"), "utf8"));
if (hb.account.toLowerCase() !== `nt service\\${service}`.toLowerCase()) fail(`the harbor runs as ${hb.account}, not NT SERVICE\\${service}`);
console.log(`PASS the harbor runs as ${hb.account}`);
const info = JSON.parse(fs.readFileSync(path.join(home, "state", "core.json"), "utf8"));
const f = await Ferry.connect(`\\\\.\\pipe\\${pipe}`);
await f.call("island.hello", { token: info.token, ferry: { name: "ci", version: "0" }, as: "ci" });
await f.call("vault.write", { path: "/hello.md", text: "from the person, through the door" });
const r = await f.call("vault.read", { path: "/hello.md" });
if (r.text !== "from the person, through the door") fail("the vault write didn't come back");
const s = await f.call("island.status");
console.log(`PASS a person came in through the door and wrote to the vault (island "${s.name}", seq ${s.seq})`);
f.close();
const log = fs.readdirSync(path.join(home, "log")).map((x) => fs.readFileSync(path.join(home, "log", x), "utf8")).join("");
if (!/"kind":"island.start"/.test(log)) fail("no island.start in the log");
console.log("PASS ALL");
