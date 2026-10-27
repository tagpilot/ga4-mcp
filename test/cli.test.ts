import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenCache, cacheFileFor } from '../src/auth/cache.js';
import { logout, savedTokenFiles, status } from '../src/cli.js';
import { loadConfig } from '../src/config.js';

describe('CLI helpers without the API key in the shell', () => {
  let dir: string;
  const now = Date.UTC(2026, 9, 27, 12, 0, 0);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-cli-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = (apiKey?: string) => loadConfig({ GA4_MCP_CONFIG_DIR: dir, ...(apiKey ? { TAGPILOT_API_KEY: apiKey } : {}) });

  function save(key: string, token: object): string {
    const file = cacheFileFor(dir, key);
    new TokenCache(file).write(token);
    return file;
  }

  test('status lists every saved sign-in when no key is set', () => {
    save('tpk_a', { refresh_token: 'r', access_token: 'a', expiry: now + 60_000 });
    save('tpk_b', { refresh_token: 'r', access_token: 'a', expiry: now - 1 });
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');

    const lines = status(config(), null, now);

    assert.match(lines.join('\n'), /api key: not set in this shell \(normal/);
    assert.ok(lines.includes('saved sign-ins: 2'));
    assert.equal(lines.filter((l) => /signed in \(access token valid until 2026-10-27T12:01:00/.test(l)).length, 1);
    assert.equal(lines.filter((l) => /expired, refreshes on next use/.test(l)).length, 1);
  });

  test('status with no saved sign-ins says how to sign in', () => {
    assert.match(status(config(), null, now).join('\n'), /saved sign-ins: 0 \(none in .*first GA4 question/);
  });

  test('logout without a key removes every saved sign-in, and only those', () => {
    save('tpk_a', { refresh_token: 'r' });
    save('tpk_b', { refresh_token: 'r' });
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');

    const lines = logout(config(), null);

    assert.equal(lines.filter((l) => l.startsWith('Removed ')).length, 2);
    assert.deepEqual(savedTokenFiles(dir), []);
    assert.ok(fs.existsSync(path.join(dir, 'unrelated.json')));
  });

  test('logout with a key removes only that key\'s sign-in', () => {
    const a = save('tpk_a', { refresh_token: 'r' });
    const b = save('tpk_b', { refresh_token: 'r' });

    logout(config('tpk_a'), a);

    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), true);
  });

  test('logout with nothing saved says so', () => {
    assert.match(logout(config(), null)[0], /No saved Google sign-ins/);
  });
});
