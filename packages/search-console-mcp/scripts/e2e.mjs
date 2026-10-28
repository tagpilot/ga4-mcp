// End-to-end smoke test of the BUILT server (dist/index.js) over stdio: a mock tc-api (device connect
// D1/D5 + token D6) and mock Search Console APIs on one local HTTP server, a throwaway credential
// directory, and a fake "browser" that approves the link.
// Run: npm run build && npm run e2e   (optional argument: another entry point, e.g. the unpacked .mcpb's)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.resolve(process.argv[2] ?? path.join(root, 'dist/index.js'));
const DEVICE_KEY = 'tpk_gsc_device_secret';
let d1;
let approved = false;
const seen = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    seen.push(`${req.method} ${url.pathname}`);
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/connect') {
      approved = true;
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('Connected.');
    }
    if (!String(req.headers['user-agent']).startsWith('tagpilot-search-console-mcp/')) return json(400, { error: 'bad ua' });
    if (url.pathname === '/v3/public/ga4/device') {
      d1 = body;
      return json(201, {
        device_code: 'dev-1', user_code: 'GSCX-2345', verification_uri: `${base}/connect`,
        verification_uri_complete: `${base}/connect?code=GSCX-2345`, interval: 1, expires_in: 600,
      });
    }
    if (url.pathname === '/v3/public/ga4/device/token') {
      return approved ? json(200, { status: 'complete', api_key: DEVICE_KEY, code: 'gsc-code' }) : json(400, { error: 'authorization_pending' });
    }
    if (url.pathname === '/integrations/v1/ga4/oauth/token') {
      if (req.headers.authorization !== `Bearer ${DEVICE_KEY}`) return json(401, { code: 401, message: 'Invalid API key' });
      assert.equal(body.code, 'gsc-code');
      return json(200, { access_token: 'ya29.gsc', expires_in: 3599, refresh_token: '1//gsc', scope: 'https://www.googleapis.com/auth/webmasters.readonly' });
    }
    // --- Search Console APIs ---
    if (req.headers.authorization !== 'Bearer ya29.gsc') return json(401, { error: { code: 401, message: 'bad token' } });
    if (url.pathname === '/sites') return json(200, { siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
    if (url.pathname === '/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
      assert.equal(body.type, 'web');
      return json(200, { rows: [{ keys: ['buty damskie'], clicks: 42, impressions: 1200, ctr: 0.035, position: 6.3 }], responseAggregationType: 'byProperty' });
    }
    if (url.pathname === '/urlInspection/index:inspect') {
      return json(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } });
    }
    json(404, { error: { code: 404, message: `mock: no route ${url.pathname}` } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-console-mcp-e2e-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TAGPILOT_API_URL: base,
    SEARCH_CONSOLE_MCP_WEBMASTERS_API_URL: base,
    SEARCH_CONSOLE_MCP_INSPECTION_API_URL: base,
    SEARCH_CONSOLE_MCP_CONFIG_DIR: configDir,
    SEARCH_CONSOLE_MCP_NO_BROWSER: '1',
    SEARCH_CONSOLE_MCP_AUTH_WAIT_SECONDS: '1',
  },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (d) => (stderr += d));
const client = new Client({ name: 'E2E Client', version: '1' });
await client.connect(transport);
const text = (r) => r.content[0].text;

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '));

const first = await client.callTool({ name: 'list_sites', arguments: {} });
assert.equal(first.isError, true);
assert.match(text(first), /^Not connected yet\./);
assert.match(text(first), /\[Connect Tag Pilot Search Console MCP\]\(\S+\)\nCode: \*\*GSCX-2345\*\*/);
assert.equal(d1.product, 'gsc', 'D1 names the product');
assert.equal(d1.client.name, 'E2E Client');
assert.match(stderr, /\[search-console-mcp\] Tag Pilot - Search Console MCP: connect this computer/, 'own log prefix, plain text');
assert.doesNotMatch(stderr, /\[ga4-mcp\]/);
await fetch(text(first).match(/\]\((https?:\/\/[^)\s]+)\)/)[1]);
const deviceJson = path.join(configDir, 'device.json');
for (let i = 0; i < 100 && !fs.existsSync(deviceJson); i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(fs.statSync(deviceJson).mode & 0o777, 0o600);
assert.equal(JSON.parse(fs.readFileSync(deviceJson, 'utf8')).api_key, DEVICE_KEY);
console.log('device connect (product gsc) → device.json ✓');
const status = text(await client.callTool({ name: 'connection_status', arguments: {} }));
assert.match(status, /^connected: Tag Pilot Search Console MCP is connected as device 'Search Console MCP · E2E Client on /);
console.log('connection_status →', status);

const sites = await client.callTool({ name: 'list_sites', arguments: {} });
console.log('list_sites →', text(sites));
const sa = await client.callTool({ name: 'search_analytics', arguments: { site_url: 'sc-domain:example.com', dimensions: ['query'] } });
assert.deepEqual(JSON.parse(text(sa)).rows, [{ query: 'buty damskie', clicks: 42, impressions: 1200, ctr: 0.035, position: 6.3 }]);
console.log('search_analytics →', text(sa).slice(0, 160) + '…');
const insp = await client.callTool({ name: 'inspect_url', arguments: { site_url: 'sc-domain:example.com', url: 'https://example.com/a' } });
assert.equal(JSON.parse(text(insp)).verdict, 'PASS');
console.log('inspect_url → PASS');
assert.ok(!stderr.includes(DEVICE_KEY), 'device key never logged');

await client.close();
server.close();
fs.rmSync(configDir, { recursive: true });
console.log('requests:', seen.length);
console.log('E2E OK');
