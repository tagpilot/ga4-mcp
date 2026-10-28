// Smoke test of the built .mcpb: unpack it into a temp dir (no node_modules above it, so the server
// can only use what the bundle ships), check the tools match manifest.json, then run the full e2e
// script against the bundled entry point. Usage: node scripts/mcpb-smoke.mjs <package-name>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const name = process.argv[2];
if (!name) throw new Error('usage: node scripts/mcpb-smoke.mjs <package-name>');
const pkgDir = path.join(root, 'packages', name);
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const envPrefix = name.replace(/-/g, '_').toUpperCase(); // ga4-mcp → GA4_MCP
const bundle = path.join(pkgDir, `tagpilot-${name}-${pkg.version}.mcpb`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-mcpb-`));
execFileSync(path.join(root, 'node_modules/.bin/mcpb'), ['unpack', bundle, dir], { stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
const entry = path.join(dir, manifest.server.entry_point);
const args = manifest.server.mcp_config.args.map((a) => a.replace('${__dirname}', dir));

// As Claude Desktop starts it, with the optional key field left empty: the server starts, lists its
// tools, and the first call starts the device connect (against an unreachable API here, so it
// can't touch the real one or a real ~/.config credential).
const smokeConfig = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-mcpb-config-`));
const transport = new StdioClientTransport({
  command: process.execPath,
  args,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TAGPILOT_API_KEY: '',
    TAGPILOT_API_URL: 'http://127.0.0.1:9',
    [`${envPrefix}_CONFIG_DIR`]: smokeConfig,
    [`${envPrefix}_NO_BROWSER`]: '1',
  },
  cwd: os.tmpdir(),
  stderr: 'pipe',
});
const client = new Client({ name: 'mcpb-smoke', version: '0' });
await client.connect(transport);
assert.equal(client.getServerVersion()?.version, pkg.version);
const { tools } = await client.listTools();
assert.deepEqual(tools.map((t) => t.name).sort(), manifest.tools.map((t) => t.name).sort(), 'manifest.json tools match the server');
const noKey = await client.callTool({ name: tools[0].name, arguments: {} });
assert.equal(noKey.isError, true);
assert.match(noKey.content[0].text, /Could not reach Tag Pilot at http:\/\/127\.0\.0\.1:9/, 'no key → device connect starts');
await client.close();
fs.rmSync(smokeConfig, { recursive: true });
console.log(`bundle starts, ${tools.length} tools match manifest.json, no key → device connect`);

execFileSync(process.execPath, [path.join(pkgDir, 'scripts/e2e.mjs'), entry], { stdio: 'inherit' });
fs.rmSync(dir, { recursive: true });
console.log(`MCPB OK: ${path.basename(bundle)}`);
