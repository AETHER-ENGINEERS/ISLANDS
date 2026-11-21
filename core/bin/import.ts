#!/usr/bin/env node
// Move in from the Atelier: bring a full backup ("Export everything" in pandora-dee or Jade Vault) into an island.
// Stop the island's core first (the harbor service, or Ctrl+C in its console); this refuses while it runs.
//
//   node core/bin/import.ts <home> <backup.json[.gz]> [--as <your name>] [--self <the island's own name>]

import { importBackup } from "../src/importer.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const person = flag("--as");
const self = flag("--self");
const [home, file] = args;
if (!home || !file) {
  console.error("usage: node core/bin/import.ts <home> <backup.json[.gz]> [--as <your name>] [--self pandora]");
  process.exit(2);
}
try {
  const r = importBackup(home, file, { person, self });
  console.log(`Moved in: ${r.vault.written} files (${r.vault.same} already here, ${r.vault.beside.length} kept beside), ${r.chats.imported} chats (${r.chats.messages} messages), ${r.schedules.imported} schedules (switched off).`);
  console.log(`The report is in her vault: ${r.file}`);
  if (r.vault.refused.length) console.log(`Couldn't bring in ${r.vault.refused.length} files; the report lists them.`);
} catch (e) {
  console.error(`Not moved in: ${(e as Error).message}`);
  process.exit(1);
}
