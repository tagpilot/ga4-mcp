import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API_URL = 'https://api.tagpilot.io';
export const APP_URL = 'https://app.tagpilot.io';
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

export interface Config {
  /** "broker": tokens via the Tag Pilot API (normal). "dev": straight to Google with your own Desktop client. */
  mode: 'broker' | 'dev';
  apiKey?: string;
  apiUrl: string;
  devClientId?: string;
  devClientSecret?: string;
  /** Directory for the token cache (default ~/.config/tagpilot/ga4-mcp). */
  cacheDir: string;
  /** Fixed loopback port (for SSH port forwarding); random when unset. */
  oauthPort?: number;
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
  const devClientId = env.GA4_MCP_DEV_GOOGLE_CLIENT_ID?.trim() || undefined;
  const devClientSecret = env.GA4_MCP_DEV_GOOGLE_CLIENT_SECRET?.trim() || undefined;
  const oauthPort = intEnv(env.GA4_MCP_OAUTH_PORT, 'GA4_MCP_OAUTH_PORT');
  if (oauthPort !== undefined && (oauthPort < 1024 || oauthPort > 65535)) {
    throw new Error('GA4_MCP_OAUTH_PORT must be between 1024 and 65535');
  }
  const waitSeconds = intEnv(env.GA4_MCP_AUTH_WAIT_SECONDS, 'GA4_MCP_AUTH_WAIT_SECONDS') ?? 45;
  return {
    mode: devClientId && devClientSecret ? 'dev' : 'broker',
    apiKey: env.TAGPILOT_API_KEY?.trim() || undefined,
    apiUrl: (env.TAGPILOT_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ''),
    devClientId,
    devClientSecret,
    cacheDir: env.GA4_MCP_CONFIG_DIR?.trim() || path.join(os.homedir(), '.config', 'tagpilot', 'ga4-mcp'),
    oauthPort,
    authWaitMs: waitSeconds * 1000,
    openBrowser: !['1', 'true', 'yes'].includes((env.GA4_MCP_NO_BROWSER ?? '').toLowerCase()),
    browser: env.GA4_MCP_BROWSER?.trim() || undefined,
    adminApiUrl: (env.GA4_MCP_ADMIN_API_URL?.trim() || 'https://analyticsadmin.googleapis.com').replace(/\/+$/, ''),
    dataApiUrl: (env.GA4_MCP_DATA_API_URL?.trim() || 'https://analyticsdata.googleapis.com').replace(/\/+$/, ''),
  };
}

export const MISSING_KEY_MESSAGE =
  'TAGPILOT_API_KEY is not set. The GA4 MCP is free, but it needs a Tag Pilot API key to sign in with Google: ' +
  `create one on the GA4 MCP page at ${APP_URL}, then add it to this server's environment, e.g.\n` +
  '  claude mcp add ga4 --env TAGPILOT_API_KEY=tpk_... -- npx -y @tagpilot/ga4-mcp';
