// The distribution manifests (MCP Registry, Gemini CLI, Claude Desktop) must match package.json and
// the server's real tool list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { VERSION } from '../src/version.js';

// Compiled to build-test/packages/ga4-mcp/test/; the package sources are in packages/ga4-mcp.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/ga4-mcp');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (f: string): any => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const pkg = read('package.json');

test('every manifest carries the package version', () => {
  const server = read('server.json');
  const gemini = read('gemini-extension.json');
  const mcpb = read('mcpb/manifest.json');
  assert.equal(VERSION, pkg.version, 'src/version.ts');
  assert.equal(server.version, pkg.version, 'server.json version');
  assert.equal(server.packages[0].version, pkg.version, 'server.json packages[0].version');
  assert.equal(gemini.version, pkg.version, 'gemini-extension.json version');
  assert.deepEqual(gemini.mcpServers.ga4.args, ['-y', `${pkg.name}@${pkg.version}`], 'gemini-extension.json pins the package');
  assert.equal(mcpb.version, pkg.version, 'mcpb/manifest.json version');
});

test('the MCP Registry name and npm identifier match package.json', () => {
  const server = read('server.json');
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.ok(server.description.length <= 100, 'registry description limit');
});

test('the Claude Desktop manifest lists exactly the server tools', async () => {
  const server = createServer({ async getAccessToken() { return 'x'; }, invalidateAccessToken() {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  const listed = (read('mcpb/manifest.json').tools as { name: string }[]).map((t) => t.name);
  assert.deepEqual(listed.sort(), tools.map((t) => t.name).sort());
  await client.close();
});
