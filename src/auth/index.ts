import type { Config } from '../config.js';
import { MISSING_KEY_MESSAGE } from '../config.js';
import { SetupError } from '../errors.js';
import { openBrowser } from './browser.js';
import { cacheFileFor, TokenCache } from './cache.js';
import { BrokerEndpoint, DirectGoogleEndpoint } from './endpoints.js';
import { TokenManager, type AccessTokenSource } from './token-manager.js';

/** Cache key: the API key in broker mode, the client ID in dev mode. */
function cacheKey(config: Config): string | undefined {
  if (config.mode === 'dev') return `dev:${config.devClientId}`;
  return config.apiKey;
}

export function createTokenManager(config: Config): TokenManager | null {
  const key = cacheKey(config);
  if (!key) return null;
  const endpoint =
    config.mode === 'dev'
      ? new DirectGoogleEndpoint(config.devClientId!, config.devClientSecret!)
      : new BrokerEndpoint(config.apiUrl, config.apiKey!);
  return new TokenManager({
    endpoint,
    cache: new TokenCache(cacheFileFor(config.cacheDir, key)),
    authWaitMs: config.authWaitMs,
    port: config.oauthPort,
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
