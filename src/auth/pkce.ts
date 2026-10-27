import crypto from 'node:crypto';

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48)); // 64 chars, within RFC 7636's 43–128
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
