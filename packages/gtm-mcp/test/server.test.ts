// All tools through the MCP protocol (in-memory transport) with a mocked Tag Manager API.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import { mockFetch, withConnection } from '../../mcp-core/test/helpers.js';
import { PRODUCT } from '../src/product.js';
import { ACCOUNT, CONTAINER, WORKSPACE, gtmRoutes } from './fixtures.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const API = 'https://tagmanager.googleapis.com/tagmanager/v2';

async function connect(respond: Parameters<typeof mockFetch>[0] = gtmRoutes) {
  const f = mockFetch(respond);
  const tokens = { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const server = createServer(withConnection(tokens, PRODUCT), { fetchImpl: f.fetch, retryBaseMs: 0 }, () => NOW);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = (res.content[0] as { text: string }).text;
    return { isError: res.isError ?? false, text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, calls: f.calls };
}

const C = { account_id: ACCOUNT, container_id: CONTAINER };

describe('GTM MCP server', () => {
  test('lists the read-only tools; list_accounts first', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [
      'list_accounts',
      'list_containers',
      'list_workspaces',
      'get_container',
      'list_versions',
      'get_live_version',
      'get_tag',
      'get_trigger',
      'get_variable',
      'find_references',
      'diff',
      'audit_container',
      'connect',
      'connection_status',
    ]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.ok(JSON.stringify(tools).length < 30_000, `tool list stays compact (${JSON.stringify(tools).length} bytes)`);
  });

  test('only GET requests, with the product user agent', async () => {
    const { call, calls } = await connect();
    await call('audit_container', { ...C, workspace_id: WORKSPACE });
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.equal(c.init.method, 'GET', c.url);
      assert.equal((c.init.headers as Record<string, string>)['user-agent'], 'tagpilot-gtm-mcp/0.1.0');
    }
  });

  test('list_accounts, list_containers, list_workspaces', async () => {
    const { call, calls } = await connect();
    assert.deepEqual((await call('list_accounts')).json.accounts, [{ account_id: ACCOUNT, name: 'Shop' }]);
    assert.equal(calls[0].url, `${API}/accounts`);
    const containers = await call('list_containers', { account_id: ACCOUNT });
    assert.deepEqual(containers.json.containers[0], { container_id: CONTAINER, public_id: 'GTM-ABC1234', name: 'shop.example.com', usage_context: ['web'], domains: ['shop.example.com'] });
    const ws = await call('list_workspaces', { account_id: ACCOUNT, container_id: 'gtm-abc1234' });
    assert.equal(ws.json.container_id, CONTAINER, 'public id resolved');
    assert.deepEqual(ws.json.workspaces, [{ workspace_id: WORKSPACE, name: 'Default Workspace' }]);
    assert.equal(calls.filter((c) => c.url.endsWith(`/accounts/${ACCOUNT}/containers`)).length, 1, 'container list cached');
  });

  test('get_container reads the live version in ONE call, compact', async () => {
    const { call, calls } = await connect();
    const res = await call('get_container', C);
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(calls.map((c) => c.url), [`${API}/accounts/${ACCOUNT}/containers/${CONTAINER}/versions/live`]);
    assert.deepEqual(res.json.source, { version_id: '12', name: 'Black Friday', live: true });
    assert.equal(res.json.counts.tags, 6);
    assert.equal(res.json.counts.paused_tags, 1);
    const pixel = res.json.tags.find((t: { id: string }) => t.id === '4');
    assert.deepEqual(pixel, { id: '4', name: 'Meta Pixel', type: 'html', folder: 'Marketing', firing: ['All Pages (built-in)'], blocking: ['Internal traffic'] });
    assert.equal(res.json.tags.find((t: { id: string }) => t.id === '5').template, 'Hotjar (gallery)');
    assert.deepEqual(res.json.templates, [{ id: '40', name: 'Hotjar (gallery)', gallery: 'hotjar/gtm-template' }]);
    assert.ok(!res.text.includes('fingerprint') && !res.text.includes('___INFO___'), 'no metadata or template source');
    // Second call within the cache window: no new request.
    await call('get_tag', { ...C, name: 'Meta Pixel' });
    assert.equal(calls.length, 1);
  });

  test('get_container of a workspace: one list call per kind, no clients for web', async () => {
    const { call, calls } = await connect();
    const res = await call('get_container', { ...C, workspace_id: WORKSPACE, detail: 'full' });
    assert.equal(res.isError, false, res.text);
    const paths = calls.map((c) => c.url.replace(`${API}/accounts/${ACCOUNT}/containers/${CONTAINER}`, '')).sort();
    assert.deepEqual(paths, ['', '/workspaces/7', '/workspaces/7/built_in_variables', '/workspaces/7/folders', '/workspaces/7/tags', '/workspaces/7/templates', '/workspaces/7/triggers', '/workspaces/7/variables']);
    assert.deepEqual(res.json.source, { workspace_id: '7', name: 'Default Workspace' });
    assert.equal(res.json.templates[0].templateDataChars, 16);
    assert.equal(res.json.tags[0].path, undefined);
  });

  test('pagination is followed', async () => {
    const { call, calls } = await connect((url) => {
      if (url.endsWith('/accounts')) return { body: { account: [{ accountId: '1', name: 'A' }], nextPageToken: 'p2' } };
      return { body: { account: [{ accountId: '2', name: 'B' }] } };
    });
    const res = await call('list_accounts');
    assert.equal(res.json.accounts.length, 2);
    assert.equal(calls[1].url, `${API}/accounts?pageToken=p2`);
  });

  test('get_tag / get_trigger / get_variable resolve names and references', async () => {
    const { call } = await connect();
    const tag = await call('get_tag', { ...C, id: '2' });
    assert.equal(tag.json.tag.name, 'GA4 - purchase');
    assert.deepEqual(tag.json.firing_triggers, [{ id: '10', name: 'CE - purchase' }]);
    assert.deepEqual(tag.json.uses, { variables: ['DLV - value'], built_in_variables: [] });
    const trig = await call('get_trigger', { ...C, name: 'internal TRAFFIC' });
    assert.deepEqual(trig.json.used_by, [{ kind: 'tag', id: '4', name: 'Meta Pixel', type: 'html', via: 'blockingTriggerId' }]);
    assert.deepEqual(trig.json.uses.variables, ['Cookie - internal']);
    const builtIn = await call('get_variable', { ...C, name: '{{Page URL}}' });
    assert.equal(builtIn.json.variable.built_in, true);
    assert.deepEqual(builtIn.json.used_by.map((r: { name: string }) => r.name), ['Orphan tag']);
    const missing = await call('get_tag', { ...C, name: 'GA4' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Similar names: "GA4 - purchase" \(2\), "Old GA4 config" \(3\)/);
  });

  test('find_references: variable, trigger, template', async () => {
    const { call } = await connect();
    const v = await call('find_references', { ...C, kind: 'variable', name: 'DLV - value' });
    assert.deepEqual(v.json.used_by, [{ kind: 'tag', id: '2', name: 'GA4 - purchase', type: 'gaawe', via: '{{DLV - value}}' }]);
    const t = await call('find_references', { ...C, kind: 'trigger', id: '12' });
    assert.equal(t.json.count, 0);
    assert.match(t.json.note, /Nothing in the live version 12 uses it/);
    const tpl = await call('find_references', { ...C, kind: 'template', name: 'Hotjar (gallery)' });
    assert.deepEqual(tpl.json.used_by.map((r: { id: string }) => r.id), ['5']);
  });

  test('list_versions marks the live one, newest first', async () => {
    const { call } = await connect();
    const res = await call('list_versions', C);
    assert.equal(res.json.live_version_id, '12');
    assert.deepEqual(res.json.versions[0], { version_id: '12', name: 'Black Friday', live: true, tags: 6, triggers: 3, variables: 3, templates: 1 });
    assert.equal(res.json.versions[1].version_id, '11');
  });

  test('get_live_version', async () => {
    const { call } = await connect();
    const res = await call('get_live_version', C);
    assert.equal(res.json.version.description, 'BF tags');
    assert.equal(res.json.counts.tags, 6);
  });

  test('diff: workspace vs live', async () => {
    const { call } = await connect();
    const res = await call('diff', { ...C, workspace_id: WORKSPACE, include_values: true });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.json.summary, { added: 1, changed: 1, deleted: 1 });
    assert.deepEqual(res.json.added, [{ kind: 'tag', id: '7', name: 'LinkedIn Insight', type: 'html' }]);
    assert.deepEqual(res.json.deleted, [{ kind: 'tag', id: '6', name: 'Orphan tag', type: 'img' }]);
    const changed = res.json.changed[0];
    assert.deepEqual(changed.fields, ['consentSettings', 'name'], 'fingerprint ignored');
    assert.equal(changed.renamed_from, 'Meta Pixel');
    assert.deepEqual(changed.after.consentSettings, { consentStatus: 'needed' });
    assert.deepEqual(res.json.not_compared, ['zone']);
  });

  test('audit_container of a workspace', async () => {
    const { call } = await connect();
    const res = await call('audit_container', { ...C, workspace_id: WORKSPACE });
    assert.equal(res.isError, false, res.text);
    const by = Object.fromEntries(res.json.findings.map((f: { check: string }) => [f.check, f]));
    assert.deepEqual(Object.keys(by), ['missing_triggers', 'duplicate_google_tags', 'tags_without_consent_settings', 'unused_triggers', 'unused_variables', 'paused_tags', 'unpublished_changes']);
    assert.deepEqual(by.missing_triggers.items, [{ name: 'LinkedIn Insight', type: 'html', trigger_id: '999', via: 'firingTriggerId' }]);
    assert.equal(by.duplicate_google_tags.items[0].tag_id, 'G-AAA111');
    assert.deepEqual(by.tags_without_consent_settings.items.map((i: { id: string }) => i.id), ['7'], 'consent fixed on tag 4 in the workspace');
    assert.deepEqual(by.unused_triggers.items.map((i: { id: string }) => i.id), ['12']);
    assert.deepEqual(by.unused_variables.items.map((i: { id: string }) => i.id), ['22']);
    assert.match(by.unpublished_changes.message, /1 added, 1 changed, 1 deleted/);
  });

  test('audit_container of the live version', async () => {
    const { call } = await connect();
    const res = await call('audit_container', C);
    const checks = res.json.findings.map((f: { check: string }) => f.check);
    assert.ok(checks.includes('tags_without_triggers'));
    const consent = res.json.findings.find((f: { check: string }) => f.check === 'tags_without_consent_settings');
    assert.deepEqual(consent.items.map((i: { id: string }) => i.id), ['4', '6'], 'Google tags and paused tags skipped');
    assert.match(res.json.tip, /workspace_id/);
  });

  test('errors are readable tool results; quota errors are retried', async () => {
    let n = 0;
    const { call, calls } = await connect(() =>
      ++n <= 2 ? { status: 403, body: { error: { code: 403, message: 'Quota exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } } : { body: { account: [] } },
    );
    assert.deepEqual((await call('list_accounts')).json.accounts, []);
    assert.equal(calls.length, 3);

    const denied = await connect(() => ({ status: 403, body: { error: { code: 403, message: 'Forbidden', status: 'PERMISSION_DENIED' } } }));
    const res = await denied.call('get_container', C);
    assert.equal(res.isError, true);
    assert.match(res.text, /no access to the live \(published\) version of container 2002/);
    assert.equal(denied.calls.length, 1, 'a plain 403 is not retried');

    const bad = await connect();
    assert.match((await bad.call('get_container', { account_id: 'abc', container_id: CONTAINER })).text, /account_id must be a numeric ID/);
    assert.match((await bad.call('get_container', { ...C, workspace_id: '7', version_id: '3' })).text, /not both/);
    assert.equal(bad.calls.length, 0, 'bad input never reaches Google');
  });

  test('a container that was never published', async () => {
    const { call } = await connect((url) => (url.endsWith('/versions/live') ? { status: 404, body: { error: { code: 404, message: 'Not found' } } } : gtmRoutes(url)));
    assert.match((await call('get_container', C)).text, /no live \(published\) version.*workspace_id/);
    const diff = await call('diff', { ...C, workspace_id: WORKSPACE });
    assert.match(diff.json.note, /never been published/);
    const audit = await call('audit_container', { ...C, workspace_id: WORKSPACE });
    assert.ok(audit.json.findings.some((f: { check: string; severity: string }) => f.check === 'unpublished_changes' && f.severity === 'medium'));
  });
});
