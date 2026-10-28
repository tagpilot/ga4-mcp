import os from 'node:os';
import path from 'node:path';
import type { Product } from './product.js';

export const DEFAULT_API_URL = 'https://api.tagpilot.io';
export const APP_URL = 'https://app.tagpilot.io';

export interface Config {
  apiKey?: string;
  apiUrl: string;
  /** Directory for the credentials (default ~/.config/tagpilot/<slug>). */
  cacheDir: string;
  /** How long a tool call waits for the browser sign-in before returning a "finish signing in" message. */
  authWaitMs: number;
  openBrowser: boolean;
  browser?: string;
}

export function intEnv(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  return n;
}

/** Shared: TAGPILOT_API_KEY, TAGPILOT_API_URL. Per product: <PREFIX>_NO_BROWSER, _BROWSER, _AUTH_WAIT_SECONDS, _CONFIG_DIR. */
export function loadConfig(product: Pick<Product, 'slug' | 'envPrefix'>, env: NodeJS.ProcessEnv = process.env): Config {
  const p = product.envPrefix;
  const waitSeconds = intEnv(env[`${p}_AUTH_WAIT_SECONDS`], `${p}_AUTH_WAIT_SECONDS`) ?? 45;
  return {
    apiKey: env.TAGPILOT_API_KEY?.trim() || undefined,
    apiUrl: (env.TAGPILOT_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ''),
    cacheDir: env[`${p}_CONFIG_DIR`]?.trim() || path.join(os.homedir(), '.config', 'tagpilot', product.slug),
    authWaitMs: waitSeconds * 1000,
    openBrowser: !['1', 'true', 'yes'].includes((env[`${p}_NO_BROWSER`] ?? '').toLowerCase()),
    browser: env[`${p}_BROWSER`]?.trim() || undefined,
  };
}
