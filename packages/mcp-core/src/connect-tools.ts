// The `connect` and `connection_status` tools, and MCP URL-mode elicitation (spec 2025-11-25): when the
// client supports it, a new sign-in also asks the client to open the link; otherwise the link is only
// returned as text. Both share one sign-in with the data tools (TokenManager dedupes it).
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectInstructions, type ConnectionManager, type ConnectionState } from './auth/token-manager.js';
import { log } from './log.js';
import { READ_ONLY, safe } from './tool-result.js';

/** How long connection_status waits for a sign-in in progress before answering. */
export const STATUS_WAIT_MS = 25_000;

export function describeState(cm: ConnectionManager, s: ConnectionState, now = Date.now()): string {
  const p = cm.product;
  switch (s.state) {
    case 'connected': {
      const who = s.mode === 'device' ? `as device '${s.deviceLabel ?? p.label}'` : 'with TAGPILOT_API_KEY';
      return `connected: ${p.title} is connected ${who}${s.keyPrefix ? ` (Tag Pilot key ${s.keyPrefix})` : ''}. The other tools are ready to use.`;
    }
    case 'waiting':
      return [
        'waiting: the sign-in is not approved yet. If the user has not seen it, show this:',
        '',
        connectInstructions(p, s, now),
        '',
        'Then call connection_status again after the user says they approved.',
      ].join('\n');
    case 'error':
      return `error: the last connect attempt failed: ${s.message}\nCall connect to get a new link for the user.`;
    default:
      return 'not_connected: this computer is not connected yet. Call connect to get a link and code for the user.';
  }
}

export interface ConnectToolsOptions {
  server: McpServer;
  connection: ConnectionManager;
  /** For tests. */
  statusWaitMs?: number;
}

/** Ask URL-elicitation-capable clients to open the link of every new sign-in; tell them when it completes. */
function wireElicitation(server: McpServer, cm: ConnectionManager): void {
  let complete: (() => Promise<void>) | null = null;
  cm.onEvent((e) => {
    const caps = server.server.getClientCapabilities();
    if (!caps?.elicitation?.url) return;
    if (e.type === 'started') {
      const elicitationId = crypto.randomUUID();
      complete = server.server.createElicitationCompletionNotifier(elicitationId);
      const message =
        e.kind === 'device'
          ? `Connect ${cm.product.title}: open this page, sign in to your free Tag Pilot account, check the code ${e.userCode} and approve, then allow ${cm.product.googleAccess}.`
          : `Sign in with Google to allow ${cm.product.googleAccess} for ${cm.product.title}.`;
      server.server
        .elicitInput({ mode: 'url', message, url: e.url, elicitationId })
        .then((r) => {
          if (r.action !== 'accept') log(`The client did not open the sign-in link (${r.action}); the link is still in the tool result.`);
        })
        .catch((err: Error) => log(`URL elicitation failed (${err.message}); the link is still in the tool result.`));
    } else if (e.type === 'connected' && complete) {
      complete().catch(() => {});
      complete = null;
    }
  });
}

export function registerConnectTools({ server, connection: cm, statusWaitMs = STATUS_WAIT_MS }: ConnectToolsOptions): void {
  wireElicitation(server, cm);
  const p = cm.product;

  server.registerTool(
    'connect',
    {
      title: `Connect ${p.label}`,
      description:
        `Connects this computer to ${p.title} (free Tag Pilot account + ${p.googleAccess}). Call it when the user asks to connect, or ` +
        'when another tool says the computer is not connected. It returns a link and a code: show both to the user as given (a clickable ' +
        'link), ask them to open it, approve and allow Google access, and tell you when done; then call connection_status. ' +
        'Never ask the user to run terminal commands. If already connected, it says so.',
      inputSchema: {},
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    safe(async () => {
      const pending = await cm.startConnect();
      if (!pending) return describeState(cm, cm.connectionState());
      return [
        'Show this to the user:',
        '',
        connectInstructions(p, pending, Date.now()),
        '',
        'Then ask them to tell you when they have approved, and call connection_status (it waits up to 25 s for the approval).',
      ].join('\n');
    }, { raw: true }),
  );

  server.registerTool(
    'connection_status',
    {
      title: `${p.label} connection status`,
      description:
        `Whether this computer is connected to ${p.title}: "connected" (with the device name), "waiting" (a sign-in link is open; ` +
        'shows the link and code again), "not_connected" (call connect) or "error" (with the next step). While a sign-in is open it ' +
        'waits up to 25 seconds for the approval before answering, so call it after the user says they approved, not in a fast loop.',
      inputSchema: {
        wait: z.boolean().optional().describe('Wait up to 25 s for an open sign-in to complete. Default true.'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ wait }) => {
      const state = wait === false ? cm.connectionState() : await cm.waitForConnection(statusWaitMs);
      return describeState(cm, state);
    }, { raw: true }),
  );
}

/** The connecting part of each server's `instructions`. */
export function connectionInstructions(p: { googleAccess: string }): string {
  return (
    'Connecting: no setup or API key is needed. The first data request (or the connect tool) starts a sign-in and returns a link and a code. ' +
    `Show the user the link (clickable) and the code exactly as given, ask them to open it in any browser, approve in their free Tag Pilot account and allow ${p.googleAccess}, ` +
    'and to tell you when they are done; then call connection_status or retry the original request yourself. Never ask the user to run terminal commands. ' +
    'If a tool says the connection expired or was revoked, call connect again.'
  );
}
