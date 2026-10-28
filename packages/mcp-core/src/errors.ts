/** Something the user has to fix in their setup (API key, scope, broker availability). */
export class SetupError extends Error {
  override name = 'SetupError';
}

/** A tool argument that can't be turned into a valid GA4 request. */
export class InputError extends Error {
  override name = 'InputError';
}
