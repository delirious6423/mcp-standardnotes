// Windows: cost of private-file checks in one long-lived process, as the MCP server makes them.
// Run after `npm run build`: node tests/private-fs-bench.mjs [path/to/private-fs.js]
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const module = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '../dist/security/private-fs.js';
const { privateDirectory } = await import(module);

const root = await mkdtemp(path.join(os.tmpdir(), 'sn-bench-'));
const dir = path.join(root, 'private');
const times = [];
for (let i = 0; i < 51; i++) {
  const start = performance.now();
  await privateDirectory(dir);
  times.push(performance.now() - start);
}
await rm(root, { recursive: true, force: true });
const rest = times.slice(1).sort((a, b) => a - b);
console.log(`${process.argv[2] ?? 'private-fs'}: first ${times[0].toFixed(0)} ms (helper start), then median ${rest[25].toFixed(1)} ms, max ${rest.at(-1).toFixed(1)} ms over 50`);
