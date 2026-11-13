// End-to-end smoke test of the BUILT server (dist/index.js) over stdio: a mock tc-api (device connect
// D1/D5 + token D6) and a mock Tag Manager API on one local HTTP server, a throwaway credential
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
const DEVICE_KEY = 'tpk_gtm_device_secret';
const C = 'accounts/6001/containers/2002';
let d1;
let approved = false;
const seen = [];

const tag = (id, name, type, extra = {}) => ({ path: `${C}/workspaces/7/tags/${id}`, tagId: id, name, type, fingerprint: String(Date.now()), ...extra });
const liveTags = [
  tag('1', 'Google tag', 'googtag', { parameter: [{ type: 'template', key: 'tagId', value: 'G-AAA111' }], firingTriggerId: ['2147479553'] }),
  tag('2', 'Meta Pixel', 'html', { parameter: [{ type: 'template', key: 'html', value: '<script>{{Page URL}}</script>' }], firingTriggerId: ['2147479553'] }),
];
const live = {
  containerVersionId: '5', name: 'v5', container: { publicId: 'GTM-ABC1234', name: 'shop.example.com', usageContext: ['web'] },
  tag: liveTags, trigger: [{ triggerId: '10', name: 'Unused', type: 'click' }], builtInVariable: [{ type: 'pageUrl', name: 'Page URL' }],
};
const wsTags = [...liveTags, tag('3', 'GA4 config (old)', 'gaawc', { parameter: [{ type: 'template', key: 'measurementId', value: 'G-AAA111' }], firingTriggerId: ['2147479553'] })];

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
    if (!String(req.headers['user-agent']).startsWith('tagpilot-gtm-mcp/')) return json(400, { error: 'bad ua' });
    if (url.pathname === '/v3/public/ga4/device') {
      d1 = body;
      return json(201, {
        device_code: 'dev-1', user_code: 'GTMX-2345', verification_uri: `${base}/connect`,
        verification_uri_complete: `${base}/connect?code=GTMX-2345&product=gtm`, interval: 1, expires_in: 600,
      });
    }
    if (url.pathname === '/v3/public/ga4/device/token') {
      return approved ? json(200, { status: 'complete', api_key: DEVICE_KEY, code: 'gtm-code' }) : json(400, { error: 'authorization_pending' });
    }
    if (url.pathname === '/integrations/v1/ga4/oauth/token') {
      if (req.headers.authorization !== `Bearer ${DEVICE_KEY}`) return json(401, { code: 401, message: 'Invalid API key' });
      assert.equal(body.code, 'gtm-code');
      return json(200, { access_token: 'ya29.gtm', expires_in: 3599, refresh_token: '1//gtm', scope: 'https://www.googleapis.com/auth/tagmanager.readonly' });
    }
    // --- Tag Manager API (GET only) ---
    if (req.method !== 'GET') return json(405, { error: { code: 405, message: `mock: ${req.method} not allowed` } });
    if (req.headers.authorization !== 'Bearer ya29.gtm') return json(401, { error: { code: 401, message: 'bad token' } });
    const p = url.pathname.replace(/^\//, '');
    const routes = {
      accounts: { account: [{ accountId: '6001', name: 'Shop' }] },
      'accounts/6001/containers': { container: [{ containerId: '2002', publicId: 'GTM-ABC1234', name: 'shop.example.com', usageContext: ['web'] }] },
      [C]: { containerId: '2002', publicId: 'GTM-ABC1234', name: 'shop.example.com', usageContext: ['web'] },
      [`${C}/versions/live`]: live,
      [`${C}/workspaces/7`]: { workspaceId: '7', name: 'Default Workspace' },
      [`${C}/workspaces/7/tags`]: { tag: wsTags },
      [`${C}/workspaces/7/triggers`]: { trigger: live.trigger },
      [`${C}/workspaces/7/variables`]: {},
      [`${C}/workspaces/7/built_in_variables`]: { builtInVariable: live.builtInVariable },
      [`${C}/workspaces/7/templates`]: {},
      [`${C}/workspaces/7/folders`]: {},
    };
    if (p in routes) return json(200, routes[p]);
    json(404, { error: { code: 404, message: `mock: no route ${url.pathname}` } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-mcp-e2e-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TAGPILOT_API_URL: base,
    GTM_MCP_TAGMANAGER_API_URL: base,
    GTM_MCP_CONFIG_DIR: configDir,
    GTM_MCP_NO_BROWSER: '1',
    GTM_MCP_AUTH_WAIT_SECONDS: '1',
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

const first = await client.callTool({ name: 'list_accounts', arguments: {} });
assert.equal(first.isError, true);
assert.match(text(first), /^Not connected yet\./);
assert.match(text(first), /\[Connect Tag Pilot GTM MCP\]\(\S+\)\nCode: \*\*GTMX-2345\*\*/);
assert.equal(d1.product, 'gtm', 'D1 names the product');
assert.equal(d1.client.name, 'E2E Client');
assert.match(stderr, /\[gtm-mcp\] Tag Pilot - GTM MCP: connect this computer/, 'own log prefix, plain text');
assert.doesNotMatch(stderr, /\[ga4-mcp\]/);
await fetch(text(first).match(/\]\((https?:\/\/[^)\s]+)\)/)[1]);
const deviceJson = path.join(configDir, 'device.json');
for (let i = 0; i < 100 && !fs.existsSync(deviceJson); i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(fs.statSync(deviceJson).mode & 0o777, 0o600);
assert.equal(JSON.parse(fs.readFileSync(deviceJson, 'utf8')).api_key, DEVICE_KEY);
console.log('device connect (product gtm) → device.json ✓');
const status = text(await client.callTool({ name: 'connection_status', arguments: {} }));
assert.match(status, /^connected: Tag Pilot GTM MCP is connected as device 'GTM MCP · E2E Client on /);
console.log('connection_status →', status);

const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
console.log('list_accounts →', text(accounts));
const container = JSON.parse(text(await client.callTool({ name: 'get_container', arguments: { account_id: '6001', container_id: 'GTM-ABC1234' } })));
assert.deepEqual(container.tags[1], { id: '2', name: 'Meta Pixel', type: 'html', firing: ['All Pages (built-in)'] });
console.log('get_container (live, by public ID) →', container.counts);
const refs = JSON.parse(text(await client.callTool({ name: 'find_references', arguments: { account_id: '6001', container_id: '2002', kind: 'variable', name: 'Page URL' } })));
assert.deepEqual(refs.used_by.map((r) => r.name), ['Meta Pixel']);
const diff = JSON.parse(text(await client.callTool({ name: 'diff', arguments: { account_id: '6001', container_id: '2002', workspace_id: '7' } })));
assert.deepEqual(diff.summary, { added: 1, changed: 0, deleted: 0 });
console.log('diff →', JSON.stringify(diff.added));
const audit = JSON.parse(text(await client.callTool({ name: 'audit_container', arguments: { account_id: '6001', container_id: '2002', workspace_id: '7' } })));
assert.equal(audit.findings[0].check, 'duplicate_google_tags');
console.log('audit_container →', audit.findings.map((f) => `${f.severity}:${f.check}`).join(', '));
const liveFetches = seen.filter((s) => s === `GET /${C}/versions/live`).length;
assert.equal(liveFetches, 1, 'the live version is cached across tools');
assert.ok(!stderr.includes(DEVICE_KEY), 'device key never logged');

await client.close();
server.close();
fs.rmSync(configDir, { recursive: true });
console.log('requests:', seen.length);
console.log('E2E OK');
