// stdout is the MCP channel: everything human-readable goes to stderr.
export function log(message: string): void {
  process.stderr.write(`[ga4-mcp] ${message}\n`);
}
