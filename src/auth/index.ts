import type { Config } from '../config.js';
import { MISSING_KEY_MESSAGE } from '../config.js';
import { SetupError } from '../errors.js';
import { openBrowser } from './browser.js';
import { cacheFileFor, TokenCache } from './cache.js';
import { BrokerEndpoint } from './endpoints.js';
import { TokenManager, type AccessTokenSource } from './token-manager.js';

export function createTokenManager(config: Config): TokenManager | null {
  if (!config.apiKey) return null;
  return new TokenManager({
    endpoint: new BrokerEndpoint(config.apiUrl, config.apiKey),
    cache: new TokenCache(cacheFileFor(config.cacheDir, config.apiKey)),
    authWaitMs: config.authWaitMs,
    openBrowser: config.openBrowser ? (url) => openBrowser(url, config.browser) : undefined,
  });
}

/** Like createTokenManager, but a missing API key surfaces as a clear error on first use, not at startup. */
export function createAccessTokenSource(config: Config): AccessTokenSource {
  const manager = createTokenManager(config);
  if (manager) return manager;
  return {
    getAccessToken: () => Promise.reject(new SetupError(MISSING_KEY_MESSAGE)),
    invalidateAccessToken: () => {},
  };
}
