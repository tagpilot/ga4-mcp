import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API_URL = 'https://api.tagpilot.io';
export const APP_URL = 'https://app.tagpilot.io';

export interface Config {
  apiKey?: string;
  apiUrl: string;
  /** Directory for the token cache (default ~/.config/tagpilot/ga4-mcp). */
  cacheDir: string;
  /** How long a tool call waits for the browser sign-in before returning a "finish signing in" message. */
  authWaitMs: number;
  openBrowser: boolean;
  browser?: string;
  adminApiUrl: string;
  dataApiUrl: string;
}

function intEnv(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const waitSeconds = intEnv(env.GA4_MCP_AUTH_WAIT_SECONDS, 'GA4_MCP_AUTH_WAIT_SECONDS') ?? 45;
  return {
    apiKey: env.TAGPILOT_API_KEY?.trim() || undefined,
    apiUrl: (env.TAGPILOT_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ''),
    cacheDir: env.GA4_MCP_CONFIG_DIR?.trim() || path.join(os.homedir(), '.config', 'tagpilot', 'ga4-mcp'),
    authWaitMs: waitSeconds * 1000,
    openBrowser: !['1', 'true', 'yes'].includes((env.GA4_MCP_NO_BROWSER ?? '').toLowerCase()),
    browser: env.GA4_MCP_BROWSER?.trim() || undefined,
    adminApiUrl: (env.GA4_MCP_ADMIN_API_URL?.trim() || 'https://analyticsadmin.googleapis.com').replace(/\/+$/, ''),
    dataApiUrl: (env.GA4_MCP_DATA_API_URL?.trim() || 'https://analyticsdata.googleapis.com').replace(/\/+$/, ''),
  };
}
