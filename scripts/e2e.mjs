// End-to-end smoke test of the BUILT server (dist/index.js) over stdio, the way an MCP client runs it:
// a mock tc-api broker + mock Google APIs on one local HTTP server, a throwaway token directory, and
// a fake "browser" that follows the sign-in URL. Run: npm run build && npm run e2e
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
const API_KEY = 'tpk_e2e_secret';
const sessions = new Map();
const seen = [];

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
    // --- Google consent + broker callback (collapsed): approving completes the session ---
    if (url.pathname === '/fake-google-consent') {
      const s = sessions.get(url.searchParams.get('session'));
      if (!s) return json(400, { error: 'invalid or expired' });
      s.status = 'complete';
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('Signed in to Tag Pilot GA4 MCP. You can close this tab and go back to your AI assistant.');
    }
    // --- broker (api-contract.md v2) ---
    if (url.pathname.startsWith('/integrations/v1/ga4/oauth/')) {
      if (req.headers.authorization !== `Bearer ${API_KEY}`) return json(401, { code: 401, message: 'Invalid API key' });
      if (!String(req.headers['user-agent']).startsWith('tagpilot-ga4-mcp/')) return json(400, { error: 'bad ua' });
      if (url.pathname.endsWith('/session')) {
        assert.deepEqual(Object.keys(body), ['code_challenge']);
        const id = `s${sessions.size + 1}`;
        sessions.set(id, { status: 'pending' });
        return json(201, { session_id: id, authorize_url: `http://127.0.0.1:${port}/fake-google-consent?session=${id}`, poll_interval: 1, expires_in: 600 });
      }
      const result = url.pathname.match(/\/session\/([^/]+)\/result$/);
      if (result) {
        const s = sessions.get(result[1]);
        if (!s) return json(404, { error: 'not_found' });
        if (s.status === 'pending') return json(200, { status: 'pending' });
        sessions.delete(result[1]);
        return json(200, { status: 'complete', code: 'e2e-code' });
      }
      if (body.grant_type === 'authorization_code') {
        assert.equal(body.code, 'e2e-code');
        return json(200, { access_token: 'ya29.e2e', expires_in: 3599, refresh_token: '1//e2e', scope: 'https://www.googleapis.com/auth/analytics.readonly', token_type: 'Bearer' });
      }
      return json(400, { error: 'invalid_grant' });
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
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-e2e-'));

const entry = path.resolve(process.argv[2] ?? path.join(root, 'dist/index.js'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TAGPILOT_API_KEY: API_KEY,
    TAGPILOT_API_URL: base,
    GA4_MCP_ADMIN_API_URL: base,
    GA4_MCP_DATA_API_URL: base,
    GA4_MCP_CONFIG_DIR: configDir,
    GA4_MCP_NO_BROWSER: '1',
    GA4_MCP_AUTH_WAIT_SECONDS: '1',
  },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (d) => (stderr += d));
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(transport);
const text = (r) => r.content[0].text;

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '));

// 1. No token yet: the call waits 1 s, then says "finish signing in" with the URL (polling goes on).
const first = await client.callTool({ name: 'get_account_summaries', arguments: {} });
assert.equal(first.isError, true);
assert.match(text(first), /Finish signing in with Google at .* then ask again/);
const authorizeUrl = text(first).match(/https?:\/\/\S+/)[0];
console.log('pending sign-in, URL from tool result:', authorizeUrl);
assert.match(stderr, /fake-google-consent/, 'URL also printed to stderr');

// 2. The "user" approves in a browser (any machine); the server's background polling picks it up.
const page = await fetch(authorizeUrl);
assert.equal(page.status, 200);
assert.match(await page.text(), /Signed in to Tag Pilot GA4 MCP/);

// 3. The background poll collects the code and caches the token (no new tool call needed)...
for (let i = 0; i < 100 && !fs.readdirSync(configDir).length; i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(fs.readdirSync(configDir).length, 1, 'token cached by background polling');
// ...so asking again just works.
const second = await client.callTool({ name: 'get_account_summaries', arguments: {} });
assert.equal(second.isError, undefined, text(second));
console.log('get_account_summaries →', text(second));

const report = await client.callTool({
  name: 'run_report',
  arguments: { property_id: '123', dimensions: ['date'], metrics: ['sessions'], date_ranges: [{ start_date: '7daysAgo', end_date: 'yesterday' }] },
});
console.log('run_report →', text(report));
assert.deepEqual(JSON.parse(text(report)).rows, [{ date: '20261026', sessions: 321 }]);

const denied = await client.callTool({ name: 'run_report', arguments: { property_id: '999', metrics: ['sessions'] } });
console.log('403 →', text(denied).split('\n')[0]);
assert.equal(denied.isError, true);

// Token cache file: per contract, mode 600.
const files = fs.readdirSync(configDir);
assert.equal(files.length, 1);
assert.match(files[0], /^[0-9a-f]{16}\.json$/);
assert.equal(fs.statSync(path.join(configDir, files[0])).mode & 0o777, 0o600);
console.log('token cache:', files[0], 'mode 600 ✓');
assert.ok(!stderr.includes(API_KEY), 'API key never logged');

await client.close();

// 4. `login` (e.g. over SSH): prints the link, polls, exits 0 once approved elsewhere.
const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-e2e-login-'));
const login = spawn(process.execPath, [entry, 'login'], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TAGPILOT_API_KEY: API_KEY, TAGPILOT_API_URL: base, GA4_MCP_CONFIG_DIR: loginDir, GA4_MCP_NO_BROWSER: '1' },
});
let loginErr = '';
let approved = false;
login.stderr.on('data', (d) => {
  loginErr += d;
  const m = loginErr.match(/https?:\/\/\S+fake-google-consent\S+/);
  if (m && !approved) {
    approved = true;
    void fetch(m[0]);
  }
});
const code = await new Promise((r) => login.on('exit', r));
assert.equal(code, 0, loginErr);
assert.match(loginErr, /Signed in\. Token saved to/);
assert.equal(fs.readdirSync(loginDir).length, 1);
fs.rmSync(loginDir, { recursive: true });
console.log('login command: printed link, polled, signed in ✓');

server.close();
fs.rmSync(configDir, { recursive: true });
console.log('broker/Google requests:', seen.join(' | '));
console.log('E2E OK');
