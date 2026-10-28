import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CachedToken {
  /** Device connect only: the ga4:mcp key Tag Pilot created for this device. */
  api_key?: string;
  /** Device connect only: the label Tag Pilot shows for this device. */
  device_label?: string;
  refresh_token?: string;
  access_token?: string;
  /** Access-token expiry, epoch milliseconds. */
  expiry?: number;
  scope?: string;
}

export const DEVICE_FILE = 'device.json';

/** `<dir>/<first 16 hex of sha256(key)>.json`: one cache per TAGPILOT_API_KEY. */
export function cacheFileFor(dir: string, key: string): string {
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(dir, `${id}.json`);
}

/** `<dir>/device.json`: the device-connect credential (its own key + Google tokens). */
export function deviceFile(dir: string): string {
  return path.join(dir, DEVICE_FILE);
}

export class TokenCache {
  constructor(readonly file: string) {}

  read(): CachedToken | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      return data && typeof data === 'object' ? (data as CachedToken) : null;
    } catch {
      return null;
    }
  }

  write(token: CachedToken): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  clear(): boolean {
    try {
      fs.unlinkSync(this.file);
      return true;
    } catch {
      return false;
    }
  }
}
