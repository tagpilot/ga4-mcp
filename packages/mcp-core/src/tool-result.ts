import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** A tool result: JSON for data, or `raw` text as-is (e.g. markdown meant for the user). */
export function ok(value: unknown, raw = false): CallToolResult {
  return { content: [{ type: 'text', text: raw && typeof value === 'string' ? value : JSON.stringify(value) }] };
}

export function fail(e: unknown): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Wraps a handler so every thrown error becomes a readable tool error instead of a protocol error. */
export function safe<A>(fn: (args: A) => Promise<unknown>, opts: { raw?: boolean } = {}): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args), opts.raw);
    } catch (e) {
      return fail(e);
    }
  };
}
