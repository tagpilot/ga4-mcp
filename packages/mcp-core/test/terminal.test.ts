import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectRenderer, codeBox, fancyTerminal } from '../src/terminal.js';
import { log, setLogName } from '../src/log.js';
import { TEST_PRODUCT } from './helpers.js';

const NOW = 1_800_000_000_000;
const started = {
  type: 'started' as const,
  kind: 'device' as const,
  url: 'https://app.tagpilot.io/connect?code=3J79-H7JH&product=gsc',
  verificationUri: 'https://app.tagpilot.io/connect',
  userCode: '3J79-H7JH',
  expiresAt: NOW + 600_000,
};

function capture(isTTY: boolean) {
  const chunks: string[] = [];
  return { stream: { isTTY, write: (c: string) => chunks.push(c) }, text: () => chunks.join('') };
}

const ANSI = /\x1b\[/;

describe('connect screen', () => {
  test('fancy only on a TTY without NO_COLOR and not TERM=dumb', () => {
    assert.equal(fancyTerminal({ write() {}, isTTY: true }, {}), true);
    assert.equal(fancyTerminal({ write() {}, isTTY: false }, {}), false);
    assert.equal(fancyTerminal({ write() {}, isTTY: true }, { NO_COLOR: '1' }), false);
    assert.equal(fancyTerminal({ write() {}, isTTY: true }, { TERM: 'dumb' }), false);
  });

  test('not a TTY (MCP host logs): plain ASCII lines with the product prefix, no ANSI', () => {
    setLogName('test-mcp');
    const out = capture(false);
    const r = createConnectRenderer({ product: TEST_PRODUCT, stream: out.stream, env: {}, retryHint: 'Ask again.', now: () => NOW, animate: true });
    r.handle(started);
    r.handle({ type: 'connected', label: 'Test MCP · CLI on box' });
    r.handle({ type: 'failed', reason: 'expired', message: 'x' });
    const text = out.text();
    assert.doesNotMatch(text, ANSI);
    assert.doesNotMatch(text, /[┌│└⠋✔✖]/);
    assert.equal(
      text,
      [
        '[test-mcp] Tag Pilot - Test MCP: connect this computer to your free Tag Pilot account.',
        '[test-mcp]   Open: https://app.tagpilot.io/connect?code=3J79-H7JH&product=gsc',
        '[test-mcp]   Or go to https://app.tagpilot.io/connect and enter the code: 3J79-H7JH',
        '[test-mcp]   Then allow read-only test access. Waiting for approval (expires in 10 min).',
        "[test-mcp] Connected as device 'Test MCP · CLI on box'.",
        '[test-mcp] The code expired before it was approved.',
        '[test-mcp]   Ask again.',
        '',
      ].join('\n'),
    );
  });

  test('NO_COLOR on a TTY is plain too', () => {
    const out = capture(true);
    createConnectRenderer({ product: TEST_PRODUCT, stream: out.stream, env: { NO_COLOR: '1' }, retryHint: 'x', now: () => NOW }).handle(started);
    assert.doesNotMatch(out.text(), ANSI);
  });

  test('TTY: title, link, big boxed code, spinner with countdown, ✔ result', async () => {
    const out = capture(true);
    let now = NOW;
    const r = createConnectRenderer({ product: TEST_PRODUCT, stream: out.stream, env: {}, retryHint: 'Run login again.', now: () => now, animate: true });
    r.handle(started);
    now += 2_000;
    await new Promise((res) => setTimeout(res, 150));
    r.handle({ type: 'connected', label: 'Test MCP · CLI on box' });
    const text = out.text();
    assert.match(text, ANSI);
    assert.match(text, /Tag Pilot · Test MCP/);
    assert.match(text, /https:\/\/app\.tagpilot\.io\/connect\?code=3J79-H7JH&product=gsc/);
    assert.match(text, /┌─+┐/);
    assert.match(text, /3 J 7 9 {2}– {2}H 7 J H/);
    assert.match(text, /On another device\? Go to https:\/\/app\.tagpilot\.io\/connect and type the code\./);
    assert.match(text, /\r\x1b\[2K .*Waiting for approval….*expires in 10:00/);
    assert.match(text, /expires in 9:58/, 'countdown updates');
    assert.match(text, /✔.*Connected as device .*'Test MCP · CLI on box'/);
    const after = out.text().length;
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(out.text().length, after, 'spinner stopped');
  });

  test('TTY failure: ✖ with the retry hint', () => {
    const out = capture(true);
    const r = createConnectRenderer({ product: TEST_PRODUCT, stream: out.stream, env: {}, retryHint: 'Run `npx -y @tagpilot/test-mcp login` to try again.', now: () => NOW });
    r.handle(started);
    r.handle({ type: 'failed', reason: 'denied', message: 'x' });
    assert.match(out.text(), /✖.*Connecting was denied or cancelled\.\n\s+Run `npx -y @tagpilot\/test-mcp login` to try again\./);
  });

  test('the code box is evenly sized', () => {
    const [top, mid, bottom] = codeBox('ABCD-1234', '').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.equal([...top].length, [...mid].length);
    assert.equal([...bottom].length, [...mid].length);
  });

  test('log lines carry the product prefix', () => {
    const orig = process.stderr.write.bind(process.stderr);
    const got: string[] = [];
    process.stderr.write = ((c: string) => (got.push(c), true)) as typeof process.stderr.write;
    try {
      setLogName('search-console-mcp');
      log('hello\nworld');
    } finally {
      process.stderr.write = orig;
      setLogName('test-mcp');
    }
    assert.deepEqual(got, ['[search-console-mcp] hello\n[search-console-mcp] world\n']);
  });
});
