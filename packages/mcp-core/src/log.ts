// stdout is the MCP channel: everything human-readable goes to stderr, prefixed with the
// product's slug (e.g. "[search-console-mcp]") so it's clear in MCP host logs whose line it is.
let name = 'tagpilot-mcp';

export function setLogName(slug: string): void {
  name = slug;
}

export function logName(): string {
  return name;
}

export function log(message: string): void {
  process.stderr.write(message.split('\n').map((line) => `[${name}] ${line}`).join('\n') + '\n');
}
