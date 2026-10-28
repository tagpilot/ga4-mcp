import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenCache, cacheFileFor } from '../src/auth/cache.js';
import { logout, savedTokenFiles, status } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { TEST_PRODUCT } from './helpers.js';

describe('CLI helpers without the API key in the shell', () => {
  let dir: string;
  const now = Date.UTC(2026, 9, 27, 12, 0, 0);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-cli-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = (apiKey?: string) => loadConfig(TEST_PRODUCT, { TEST_MCP_CONFIG_DIR: dir, ...(apiKey ? { TAGPILOT_API_KEY: apiKey } : {}) });

  function save(key: string, token: object): string {
    const file = cacheFileFor(dir, key);
    new TokenCache(file).write(token);
    return file;
  }

  test('status lists every saved sign-in when no key is set', () => {
    save('tpk_a', { refresh_token: 'r', access_token: 'a', expiry: now + 60_000 });
    save('tpk_b', { refresh_token: 'r', access_token: 'a', expiry: now - 1 });
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');

    const lines = status(TEST_PRODUCT, config(), now);

    assert.match(lines.join('\n'), /device: not connected/);
    assert.ok(lines.includes('saved TAGPILOT_API_KEY sign-ins: 2'));
    assert.equal(lines.filter((l) => /signed in \(access token valid until 2026-10-27T12:01:00/.test(l)).length, 1);
    assert.equal(lines.filter((l) => /expired, refreshes on next use/.test(l)).length, 1);
  });

  test('status with no saved sign-ins says how to sign in', () => {
    assert.match(status(TEST_PRODUCT, config(), now).join('\n'), /device: not connected \(the first question/);
  });

  test('logout without a key removes every saved sign-in, and only those', () => {
    save('tpk_a', { refresh_token: 'r' });
    save('tpk_b', { refresh_token: 'r' });
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');

    const lines = logout(TEST_PRODUCT, config());

    assert.equal(lines.filter((l) => l.startsWith('Removed ')).length, 2);
    assert.deepEqual(savedTokenFiles(dir), []);
    assert.ok(fs.existsSync(path.join(dir, 'unrelated.json')));
  });

  test('logout with a key removes only that key\'s sign-in', () => {
    const a = save('tpk_a', { refresh_token: 'r' });
    const b = save('tpk_b', { refresh_token: 'r' });

    logout(TEST_PRODUCT, config('tpk_a'));

    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), true);
  });

  test('logout with nothing saved says so', () => {
    assert.match(logout(TEST_PRODUCT, config())[0], /Nothing saved in/);
  });
});
