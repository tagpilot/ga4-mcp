import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export type Handler = (req: Recorded, url: URL) => { status: number; body?: unknown; headers?: Record<string, string> };

/** A tiny HTTP server standing in for the tc-api broker (and Google's consent page). */
export async function startMockServer(handler: Handler) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
      const rec = { method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body };
      requests.push(rec);
      const out = handler(rec, url);
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(out.body === undefined ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-mcp-test-'));
}

/** A fetch stub that records calls and answers from a list of handlers. */
export function mockFetch(respond: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    let body: unknown;
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      body = init.body;
    }
    calls.push({ url, init, body });
    const r = respond(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fn, calls };
}
