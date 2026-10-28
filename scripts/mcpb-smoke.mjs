// Smoke test of the built .mcpb: unpack it into a temp dir (no node_modules above it, so the server
// can only use what the bundle ships), check the tools match manifest.json, then run the full e2e
// script against the bundled entry point. Run: npm run mcpb && npm run mcpb:smoke
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const bundle = path.join(root, `tagpilot-ga4-mcp-${pkg.version}.mcpb`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-mcpb-'));
execFileSync(path.join(root, 'node_modules/.bin/mcpb'), ['unpack', bundle, dir], { stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
const entry = path.join(dir, manifest.server.entry_point);
const args = manifest.server.mcp_config.args.map((a) => a.replace('${__dirname}', dir));

// As Claude Desktop starts it, with the optional key field left empty: the server starts, lists its
// tools, and the first call starts the device connect (against an unreachable API here, so it
// can't touch the real one or a real ~/.config credential).
const smokeConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-mcpb-config-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TAGPILOT_API_KEY: '',
    TAGPILOT_API_URL: 'http://127.0.0.1:9',
    GA4_MCP_CONFIG_DIR: smokeConfig,
    GA4_MCP_NO_BROWSER: '1',
  },
  cwd: os.tmpdir(),
  stderr: 'pipe',
});
const client = new Client({ name: 'mcpb-smoke', version: '0' });
await client.connect(transport);
assert.equal(client.getServerVersion()?.version, pkg.version);
const { tools } = await client.listTools();
assert.deepEqual(tools.map((t) => t.name).sort(), manifest.tools.map((t) => t.name).sort(), 'manifest.json tools match the server');
const noKey = await client.callTool({ name: 'get_account_summaries', arguments: {} });
assert.equal(noKey.isError, true);
assert.match(noKey.content[0].text, /Could not reach Tag Pilot at http:\/\/127\.0\.0\.1:9/, 'no key → device connect starts');
await client.close();
fs.rmSync(smokeConfig, { recursive: true });
console.log(`bundle starts, ${tools.length} tools match manifest.json, no key → device connect`);

execFileSync(process.execPath, [path.join(root, 'scripts/e2e.mjs'), entry], { stdio: 'inherit' });
fs.rmSync(dir, { recursive: true });
console.log(`MCPB OK: ${path.basename(bundle)}`);
