// Helper commands (login/logout/status). The API key usually lives only in the MCP client's
// config, not in the user's shell, so logout and status must also work without it.
import fs from 'node:fs';
import path from 'node:path';
import { TokenCache, type CachedToken } from './auth/cache.js';
import type { Config } from './config.js';
import { VERSION } from './version.js';

/** Saved Google sign-ins in the cache directory, one file per API key. */
export function savedTokenFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^[0-9a-f]{16}\.json$/.test(f))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function describeToken(token: CachedToken | null, now: number): string {
  if (!token?.refresh_token) return 'not signed in';
  return `signed in (access token ${token.expiry && token.expiry > now ? `valid until ${new Date(token.expiry).toISOString()}` : 'expired, refreshes on next use'})`;
}

/**
 * With a key: delete that key's sign-in. Without one: delete every saved sign-in on this
 * machine, which is what "log me out" means to someone whose key is in their AI tool's config.
 */
export function logout(config: Config, keyCacheFile: string | null): string[] {
  const files = keyCacheFile ? [keyCacheFile] : savedTokenFiles(config.cacheDir);
  const removed = files.filter((f) => new TokenCache(f).clear());
  const lines = removed.length
    ? removed.map((f) => `Removed ${f}`)
    : [keyCacheFile ? 'No saved Google sign-in for this API key.' : `No saved Google sign-ins in ${config.cacheDir}.`];
  lines.push('To also revoke the access at Google, visit https://myaccount.google.com/permissions');
  return lines;
}

export function status(config: Config, keyCacheFile: string | null, now = Date.now()): string[] {
  const lines = [`version: ${VERSION}`, `mode: ${config.mode}`];
  if (config.mode === 'broker') {
    lines.push(`api url: ${config.apiUrl}`);
    lines.push(
      config.apiKey
        ? `api key: set (${config.apiKey.slice(0, 8)}…)`
        : 'api key: not set in this shell (normal: your MCP client passes it to the server; set TAGPILOT_API_KEY to check one key)',
    );
  }
  if (keyCacheFile) {
    lines.push(`token file: ${keyCacheFile}`);
    lines.push(`google: ${describeToken(new TokenCache(keyCacheFile).read(), now)}`);
    return lines;
  }
  const files = savedTokenFiles(config.cacheDir);
  lines.push(`saved sign-ins: ${files.length}${files.length ? '' : ` (none in ${config.cacheDir}; the first GA4 question in your AI tool signs in)`}`);
  for (const f of files) lines.push(`  ${f}: ${describeToken(new TokenCache(f).read(), now)}`);
  return lines;
}

export const LOGIN_NEEDS_KEY =
  '`login` needs your Tag Pilot API key, e.g.\n' +
  '  TAGPILOT_API_KEY=tpk_... npx -y @tagpilot/ga4-mcp login\n' +
  'Usually you do not need it: the first GA4 question in your AI tool opens the Google sign-in.';
