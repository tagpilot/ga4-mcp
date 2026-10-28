import type { Config } from '../config.js';
import type { Product } from '../product.js';
import { openBrowser } from './browser.js';
import { cacheFileFor, deviceFile, TokenCache } from './cache.js';
import { BrokerEndpoint, DeviceEndpoint } from './endpoints.js';
import { TokenManager } from './token-manager.js';

/**
 * TAGPILOT_API_KEY set → key sign-in with a per-key token file (§K).
 * Otherwise → device connect, saved in <config dir>/device.json (one config dir per product).
 */
export function createTokenManager(product: Product, config: Config, opts: { clientName?: () => string | undefined } = {}): TokenManager {
  const apiKey = config.apiKey;
  return new TokenManager({
    product,
    credential: apiKey ? { kind: 'key', apiKey } : { kind: 'device', device: new DeviceEndpoint(config.apiUrl, product) },
    broker: (key) => new BrokerEndpoint(config.apiUrl, key, product),
    cache: new TokenCache(apiKey ? cacheFileFor(config.cacheDir, apiKey) : deviceFile(config.cacheDir)),
    authWaitMs: config.authWaitMs,
    openBrowser: config.openBrowser ? (url) => openBrowser(url, config.browser) : undefined,
    clientName: opts.clientName,
  });
}
