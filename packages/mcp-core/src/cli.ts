// Helper commands (login/logout/status). Normally no key is configured anywhere: the device connect
// saves its credential in device.json. With TAGPILOT_API_KEY set, that key's own token file is used.
import fs from 'node:fs';
import path from 'node:path';
import { cacheFileFor, deviceFile, TokenCache, type CachedToken } from './auth/cache.js';
import type { Config } from './config.js';
import type { Product } from './product.js';

/** Token files for TAGPILOT_API_KEY sign-ins in the cache directory, one per key. */
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

const keyPrefix = (key: string) => `${key.slice(0, 8)}…`;

function describeGoogle(token: CachedToken | null, now: number): string {
  if (!token?.refresh_token) return 'not signed in';
  return `signed in (access token ${token.expiry && token.expiry > now ? `valid until ${new Date(token.expiry).toISOString()}` : 'expired, refreshes on next use'})`;
}

/**
 * With TAGPILOT_API_KEY: delete that key's sign-in. Without: delete this device's connection and
 * every saved key sign-in on this machine.
 */
export function logout(product: Product, config: Config): string[] {
  const device = deviceFile(config.cacheDir);
  const hadDevice = !config.apiKey && Boolean(new TokenCache(device).read()?.api_key);
  const files = config.apiKey
    ? [keyFile(config)]
    : [device, ...savedTokenFiles(config.cacheDir)];
  const removed = files.filter((f) => new TokenCache(f).clear());
  const lines = removed.length
    ? removed.map((f) => `Removed ${f}`)
    : [config.apiKey ? 'No saved Google sign-in for this API key.' : `Nothing saved in ${config.cacheDir}.`];
  if (hadDevice) {
    lines.push(`This device's Tag Pilot key stays listed until you revoke it under Connected devices on ${product.pageUrl}`);
  }
  lines.push('To also revoke the access at Google, visit https://myaccount.google.com/permissions');
  return lines;
}

const keyFile = (config: Config) => cacheFileFor(config.cacheDir, config.apiKey!);

export function status(product: Product, config: Config, now = Date.now()): string[] {
  const lines = [`version: ${product.version}`, `api url: ${config.apiUrl}`];
  if (config.apiKey) {
    const file = keyFile(config);
    lines.push(`credential: TAGPILOT_API_KEY (${keyPrefix(config.apiKey)})`);
    lines.push(`token file: ${file}`);
    lines.push(`google: ${describeGoogle(new TokenCache(file).read(), now)}`);
    return lines;
  }
  const file = deviceFile(config.cacheDir);
  const device = new TokenCache(file).read();
  if (device?.api_key) {
    lines.push(`device: connected${device.device_label ? ` as '${device.device_label}'` : ''} (Tag Pilot key ${keyPrefix(device.api_key)}; manage it on ${product.pageUrl})`);
    lines.push(`token file: ${file}`);
    lines.push(`google: ${describeGoogle(device, now)}`);
  } else {
    lines.push(`device: not connected (the first question in your AI tool connects it, or run \`npx -y ${product.npmName} login\`)`);
  }
  const keyFiles = savedTokenFiles(config.cacheDir);
  if (keyFiles.length) {
    lines.push(`saved TAGPILOT_API_KEY sign-ins: ${keyFiles.length}`);
    for (const f of keyFiles) lines.push(`  ${f}: ${describeGoogle(new TokenCache(f).read(), now)}`);
  }
  return lines;
}
