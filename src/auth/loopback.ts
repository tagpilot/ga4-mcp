// Local redirect target for the OAuth flow: http://127.0.0.1:<port>/callback
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export class AuthTimeoutError extends Error {
  override name = 'AuthTimeoutError';
}

export interface LoopbackSession<T> {
  port: number;
  redirectUri: string;
  /** Settles once a callback with the right state was handled (or the flow failed / timed out). */
  done: Promise<T>;
  close(): void;
}

const page = (title: string, body: string) =>
  '<!doctype html><meta charset="utf-8"><title>Tag Pilot GA4 MCP</title>' +
  '<body style="font:16px system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#1f2937">' +
  `<h2>${title}</h2><p>${body}</p></body>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Listens on 127.0.0.1 and waits for `/callback?code&state`. A callback whose `state` doesn't match
 * is answered with an error page and otherwise ignored (the flow keeps waiting), so a stray or forged
 * request can't inject a code. `onCode` runs before the browser gets its answer, so the page can tell
 * the user whether sign-in really worked.
 */
export function startLoopback<T>(opts: {
  state: string;
  port?: number;
  timeoutMs: number;
  onCode: (code: string, redirectUri: string) => Promise<T>;
}): Promise<LoopbackSession<T>> {
  return new Promise((resolveSession, rejectSession) => {
    const server = http.createServer();
    let settled = false;
    let resolveDone!: (v: T) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<T>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    let timer: NodeJS.Timeout | undefined;

    const close = () => {
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    };
    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      close();
      if (err) rejectDone(err);
      else resolveDone(value as T);
    };

    server.on('request', (req, res) => {
      const send = (status: number, html: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(html);
      };
      const address = server.address() as AddressInfo | null;
      const redirectUri = `http://127.0.0.1:${address?.port}/callback`;
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        send(404, page('Not found', 'This local address only handles the Google sign-in callback.'));
        return;
      }
      if (settled) {
        send(410, page('Sign-in already finished', 'You can close this tab.'));
        return;
      }
      if (url.searchParams.get('state') !== opts.state) {
        send(400, page('Sign-in link mismatch', 'This sign-in response belongs to a different or older sign-in attempt, so it was ignored. Start again from your AI assistant.'));
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        send(400, page('Google sign-in was not completed', `Google returned "${escapeHtml(error)}". You can close this tab and try again.`));
        finish(new Error(`Google sign-in was not completed (${error}).`));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        send(400, page('Missing authorization code', 'The callback had no code. Start again from your AI assistant.'));
        return;
      }
      settled = true; // stop accepting further callbacks while the code is exchanged
      opts.onCode(code, redirectUri).then(
        (value) => {
          send(200, page('&#10003; GA4 is connected', 'Tag Pilot GA4 MCP can now read your Google Analytics data. You can close this tab and go back to your AI assistant.'));
          close();
          resolveDone(value);
        },
        (e: Error) => {
          send(500, page('Sign-in failed', `${escapeHtml(e.message)}<br>Close this tab and try again.`));
          close();
          rejectDone(e);
        },
      );
    });

    server.on('error', (e) => {
      if (!server.listening) rejectSession(e);
    });
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      timer = setTimeout(
        () => finish(new AuthTimeoutError('Google sign-in timed out. Call the tool again to start a new sign-in.')),
        opts.timeoutMs,
      );
      timer.unref();
      resolveSession({ port, redirectUri: `http://127.0.0.1:${port}/callback`, done, close: () => finish(new Error('Sign-in cancelled.')) });
    });
  });
}
