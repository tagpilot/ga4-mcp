import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GoogleApi } from '../google/api.js';

export interface ToolContext {
  server: McpServer;
  api: GoogleApi;
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function fail(e: unknown): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Wraps a handler so every thrown error becomes a readable tool error instead of a protocol error. */
export function safe<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

export const stripPrefix = (s: string | undefined, prefix: string) => (s?.startsWith(prefix) ? s.slice(prefix.length) : s);
export const idOf = (resourceName: string | undefined) => resourceName?.split('/').pop();
