// connect / connection_status tools and URL-mode elicitation, with a real TokenManager and a fake broker.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ElicitationCompleteNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { deviceFile, TokenCache } from '../src/auth/cache.js';
import type { AuthEndpoint, DeviceEndpoint, DevicePollResult } from '../src/auth/endpoints.js';
import { TokenManager } from '../src/auth/token-manager.js';
import { registerConnectTools } from '../src/connect-tools.js';
import { tempDir, TEST_PRODUCT } from './helpers.js';

const managers: TokenManager[] = [];

/** A fake tc-api: approve() completes the device session; deny() denies it. */
function setup(opts: { capabilities?: Record<string, unknown> } = {}) {
  let starts = 0;
  let result: DevicePollResult = { status: 'pending' };
  const device = {
    start: async () => {
      starts++;
      return {
        deviceCode: `dc-${starts}`,
        userCode: `WXYZ-${1000 + starts}`,
        verificationUri: 'https://app.tagpilot.test/connect',
        verificationUriComplete: `https://app.tagpilot.test/connect?code=WXYZ-${1000 + starts}`,
        interval: 1,
        expiresIn: 600,
      };
    },
    poll: async () => result,
  } as unknown as DeviceEndpoint;
  const broker = {
    exchangeCode: async () => ({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 }),
  } as unknown as AuthEndpoint;
  const cache = new TokenCache(deviceFile(tempDir()));
  const tm = new TokenManager({
    product: TEST_PRODUCT,
    credential: { kind: 'device', device },
    broker: () => broker,
    cache,
    authWaitMs: 50,
    pollIntervalMs: 10,
    clientName: () => 'Test Client',
  });
  managers.push(tm);
  return {
    tm,
    cache,
    starts: () => starts,
    approve: () => (result = { status: 'complete', apiKey: 'tpk_device_xyz', code: 'g-code' }),
    deny: () => (result = { status: 'denied', googleError: 'access_denied' }),
    async connectClient() {
      const server = new McpServer({ name: 't', version: '0' });
      registerConnectTools({ server, connection: tm, statusWaitMs: 2000 });
      const client = new Client({ name: 'c', version: '0' }, { capabilities: opts.capabilities ?? {} });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
        return { isError: res.isError ?? false, text: (res.content[0] as { text: string }).text };
      };
      return { client, call };
    },
  };
}

describe('connect and connection_status tools', () => {
  afterEach(() => {
    for (const m of managers.splice(0)) m.close();
  });

  test('not connected → connect gives link + code → status waits for the approval → connected', async () => {
    const s = setup();
    const { call } = await s.connectClient();

    assert.match((await call('connection_status', { wait: false })).text, /^not_connected: .*Call connect/);

    const c = await call('connect');
    assert.equal(c.isError, false);
    assert.match(c.text, /^Show this to the user:/);
    assert.match(c.text, /\[Connect Tag Pilot Test MCP\]\(https:\/\/app\.tagpilot\.test\/connect\?code=WXYZ-1001\)\nCode: \*\*WXYZ-1001\*\*/);
    assert.match(c.text, /call connection_status/);

    const again = await call('connect');
    assert.match(again.text, /WXYZ-1001/, 'reuses the open session');
    assert.equal(s.starts(), 1);

    const waiting = await call('connection_status', { wait: false });
    assert.match(waiting.text, /^waiting: .*\n\n\[Connect Tag Pilot Test MCP\]/);

    setTimeout(() => s.approve(), 50);
    const t0 = Date.now();
    const done = await call('connection_status');
    assert.ok(Date.now() - t0 < 1500, 'returned as soon as the connect completed');
    assert.equal(done.text, `connected: Tag Pilot Test MCP is connected as device 'Test MCP · Test Client on ${os.hostname()}' (Tag Pilot key tpk_devi…). The other tools are ready to use.`);
    assert.equal(s.cache.read()!.device_label, `Test MCP · Test Client on ${os.hostname()}`);

    assert.match((await call('connect')).text, /^connected: /, 'connect when already connected');
  });

  test('connection_status gives up after its wait and shows the link again', async () => {
    const s = setup();
    const { call } = await s.connectClient();
    await call('connect');
    const server = new McpServer({ name: 't2', version: '0' });
    registerConnectTools({ server, connection: s.tm, statusWaitMs: 30 });
    const client = new Client({ name: 'c', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: 'connection_status', arguments: {} })) as CallToolResult;
    assert.match((res.content[0] as { text: string }).text, /^waiting: .*WXYZ-1001/s);
  });

  test('a denied connect is reported as an error with the next step', async () => {
    const s = setup();
    const { call } = await s.connectClient();
    await call('connect');
    s.deny();
    const res = await call('connection_status');
    assert.match(res.text, /^error: the last connect attempt failed: Connecting was not completed \(Google sign-in: access_denied\)/);
    assert.match(res.text, /Call connect to get a new link/);
    await call('connect');
    assert.equal(s.starts(), 2, 'connect starts a fresh session after a failure');
  });

  test('URL-mode elicitation when the client supports it, then elicitation/complete', async () => {
    const s = setup({ capabilities: { elicitation: { url: {} } } });
    const { client, call } = await s.connectClient();
    const elicited: Array<Record<string, unknown>> = [];
    const completed: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicited.push(req.params as Record<string, unknown>);
      return { action: 'accept' };
    });
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, async (n) => {
      completed.push(n.params.elicitationId);
    });

    await call('connect');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(elicited.length, 1);
    assert.equal(elicited[0].mode, 'url');
    assert.equal(elicited[0].url, 'https://app.tagpilot.test/connect?code=WXYZ-1001');
    assert.match(String(elicited[0].message), /check the code WXYZ-1001/);

    s.approve();
    await call('connection_status');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(completed, [elicited[0].elicitationId]);
  });

  test('no elicitation without the client capability', async () => {
    const s = setup({ capabilities: { elicitation: { form: {} } } });
    const { client, call } = await s.connectClient();
    let elicited = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicited++;
      return { action: 'cancel' };
    });
    await call('connect');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(elicited, 0);
  });
});
