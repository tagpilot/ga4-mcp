// End-to-end smoke test of the BUILT server (dist/index.js) over stdio, the way an MCP client runs it:
// a mock tc-api (device connect D1/D5, key sign-in §K, token D6) + mock Google APIs on one local HTTP
// server, throwaway credential directories, and a fake "browser" that approves the link.
// Run: npm run build && npm run e2e
// Optional argument: another entry point to test, e.g. the unpacked .mcpb's server/index.js.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.resolve(process.argv[2] ?? path.join(root, 'dist/index.js'));
const ENV_KEY = 'tpk_env_secret';
const DEVICE_KEY = 'tpk_device_secret';
const devices = new Map(); // user_code → session
const keySessions = new Map();
const seen = [];
let lastClient;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    seen.push(`${req.method} ${url.pathname}`);
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    const html = (text) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(text);
    };
    if (!String(req.headers['user-agent']).startsWith('tagpilot-ga4-mcp/') && !url.pathname.startsWith('/connect') && !url.pathname.startsWith('/consent')) {
      return json(400, { error: 'bad ua' });
    }
    // --- device connect (v3 D1, D5) ---
    if (url.pathname === '/v3/public/ga4/device') {
      lastClient = body.client;
      const userCode = `WXYZ-${2000 + devices.size}`;
      devices.set(userCode, { deviceCode: `dev-${userCode}`, status: 'pending' });
      return json(201, {
        device_code: `dev-${userCode}`, user_code: userCode,
        verification_uri: `${base}/connect`, verification_uri_complete: `${base}/connect?code=${userCode}`,
        interval: 1, expires_in: 600,
      });
    }
    // tc-app /connect + approve + Google consent, collapsed into one page load
    if (url.pathname === '/connect') {
      const s = devices.get(url.searchParams.get('code'));
      if (!s) return json(404, {});
      s.status = 'complete';
      return html('Connected. You can close this tab and go back to your AI assistant.');
    }
    if (url.pathname === '/v3/public/ga4/device/token') {
      const s = [...devices.values()].find((d) => d.deviceCode === body.device_code);
      if (!s) return json(400, { error: 'expired_token' });
      if (s.status === 'pending') return json(400, { error: 'authorization_pending' });
      s.deviceCode = null;
      return json(200, { status: 'complete', api_key: DEVICE_KEY, code: 'e2e-code' });
    }
    // --- key-authenticated broker (§K session + D6 token) ---
    if (url.pathname.startsWith('/integrations/v1/ga4/oauth/')) {
      const key = String(req.headers.authorization).replace(/^Bearer /, '');
      if (key !== ENV_KEY && key !== DEVICE_KEY) return json(401, { code: 401, message: 'Invalid API key' });
      if (url.pathname.endsWith('/session')) {
        const id = `s${keySessions.size + 1}`;
        keySessions.set(id, 'pending');
        return json(201, { session_id: id, authorize_url: `${base}/consent?session=${id}`, poll_interval: 1, expires_in: 600 });
      }
      const result = url.pathname.match(/\/session\/([^/]+)\/result$/);
      if (result) {
        const st = keySessions.get(result[1]);
        if (!st) return json(404, { error: 'not_found' });
        if (st === 'pending') return json(200, { status: 'pending' });
        keySessions.delete(result[1]);
        return json(200, { status: 'complete', code: 'e2e-code' });
      }
      if (body.grant_type === 'authorization_code') {
        assert.equal(body.code, 'e2e-code');
        return json(200, { access_token: 'ya29.e2e', expires_in: 3599, refresh_token: '1//e2e', scope: 'https://www.googleapis.com/auth/analytics.readonly', token_type: 'Bearer' });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/consent') {
      keySessions.set(url.searchParams.get('session'), 'complete');
      return html('Signed in to Tag Pilot GA4 MCP.');
    }
    // --- Google APIs ---
    if (req.headers.authorization !== 'Bearer ya29.e2e') return json(401, { error: { code: 401, message: 'bad token' } });
    if (url.pathname === '/v1beta/accountSummaries') {
      return json(200, { accountSummaries: [{ account: 'accounts/1', displayName: 'Demo', propertySummaries: [{ property: 'properties/123', displayName: 'Demo shop', propertyType: 'PROPERTY_TYPE_ORDINARY' }] }] });
    }
    if (url.pathname === '/v1beta/properties/123:runReport') {
      return json(200, {
        dimensionHeaders: [{ name: 'date' }],
        metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }],
        rows: [{ dimensionValues: [{ value: '20261026' }], metricValues: [{ value: '321' }] }],
        rowCount: 1,
        metadata: { currencyCode: 'PLN', timeZone: 'Europe/Warsaw' },
      });
    }
    if (url.pathname === '/v1beta/properties/999:runReport') {
      return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'User does not have sufficient permissions for this property.' } });
    }
    json(404, { error: { code: 404, message: `mock: no route ${url.pathname}` } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const baseEnv = (configDir, extra = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TAGPILOT_API_URL: base,
  GA4_MCP_ADMIN_API_URL: base,
  GA4_MCP_DATA_API_URL: base,
  GA4_MCP_CONFIG_DIR: configDir,
  GA4_MCP_NO_BROWSER: '1',
  GA4_MCP_AUTH_WAIT_SECONDS: '1',
  ...extra,
});
const waitForFile = async (file) => {
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(file), `${file} written by background polling`);
};

// ===== 1. MCP server with NO key configured: device connect =====
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-e2e-'));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: baseEnv(configDir), stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', (d) => (stderr += d));
const client = new Client({ name: 'E2E Client', version: '9.9' });
await client.connect(transport);
const text = (r) => r.content[0].text;

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '));

// First call: waits 1 s, then "Connect at <url> (code …), then ask again" while polling goes on.
const first = await client.callTool({ name: 'get_account_summaries', arguments: {} });
assert.equal(first.isError, true);
assert.match(text(first), /^Connect at \S+ \(code WXYZ-2000\), then ask again\./);
const connectUrl = text(first).match(/https?:\/\/\S+/)[0];
console.log('pending connect:', text(first).split('\n')[0]);
assert.match(stderr, /confirm the code WXYZ-2000/, 'link and code also on stderr');
assert.equal(lastClient.name, 'E2E Client', 'device labelled with the MCP client name from initialize');
assert.equal(lastClient.hostname, os.hostname().slice(0, 64));

// The user approves in any browser; background polling collects the key + code and saves device.json.
const page = await fetch(connectUrl);
assert.match(await page.text(), /Connected/);
const deviceJson = path.join(configDir, 'device.json');
await waitForFile(deviceJson);
assert.equal(fs.statSync(deviceJson).mode & 0o777, 0o600);
const saved = JSON.parse(fs.readFileSync(deviceJson, 'utf8'));
assert.equal(saved.api_key, DEVICE_KEY);
assert.equal(saved.refresh_token, '1//e2e');
console.log('device.json: device key + Google tokens, mode 600 ✓');

const second = await client.callTool({ name: 'get_account_summaries', arguments: {} });
assert.equal(second.isError, undefined, text(second));
console.log('get_account_summaries →', text(second));
const report = await client.callTool({
  name: 'run_report',
  arguments: { property_id: '123', dimensions: ['date'], metrics: ['sessions'], date_ranges: [{ start_date: '7daysAgo', end_date: 'yesterday' }] },
});
assert.deepEqual(JSON.parse(text(report)).rows, [{ date: '20261026', sessions: 321 }]);
console.log('run_report →', text(report));
const denied = await client.callTool({ name: 'run_report', arguments: { property_id: '999', metrics: ['sessions'] } });
assert.equal(denied.isError, true);
console.log('403 →', text(denied).split('\n')[0].slice(0, 90) + '…');
assert.ok(!stderr.includes(DEVICE_KEY), 'device key never logged');
await client.close();

// ===== 2. CLI: status / logout on the device credential =====
const cli = (args, env) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [entry, ...args], { env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out }));
  });
const st = await cli(['status'], baseEnv(configDir));
assert.match(st.out, /device: connected \(Tag Pilot key tpk_devi…/);
assert.ok(!st.out.includes(DEVICE_KEY));
const lo = await cli(['logout'], baseEnv(configDir));
assert.match(lo.out, /Removed .*device\.json/);
assert.match(lo.out, /Connected devices/);
assert.equal(fs.existsSync(deviceJson), false);
console.log('status/logout on the device credential ✓');
fs.rmSync(configDir, { recursive: true });

// ===== 3. `login` (e.g. over SSH): device connect and TAGPILOT_API_KEY =====
async function login(extraEnv, linkPattern, expectFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-e2e-login-'));
  const p = spawn(process.execPath, [entry, 'login'], { env: baseEnv(dir, extraEnv) });
  let err = '';
  let approved = false;
  p.stderr.on('data', (d) => {
    err += d;
    const m = err.match(linkPattern);
    if (m && !approved) {
      approved = true;
      void fetch(m[0]);
    }
  });
  const code = await new Promise((r) => p.on('exit', r));
  assert.equal(code, 0, err);
  assert.match(err, /Connected\. Saved to/);
  assert.ok(fs.readdirSync(dir).some((f) => expectFile.test(f)));
  fs.rmSync(dir, { recursive: true });
}
await login({}, /https?:\/\/\S+\/connect\?code=\S+/, /^device\.json$/);
console.log('login (device connect): printed link + code, polled, connected ✓');
await login({ TAGPILOT_API_KEY: ENV_KEY }, /https?:\/\/\S+\/consent\?session=\S+/, /^[0-9a-f]{16}\.json$/);
console.log('login (TAGPILOT_API_KEY, §K): printed link, polled, signed in ✓');

server.close();
console.log('requests:', seen.length);
console.log('E2E OK');
