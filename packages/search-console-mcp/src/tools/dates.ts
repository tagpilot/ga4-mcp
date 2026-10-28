// Search Console dates are calendar days in Pacific Time (America/Los_Angeles).
import { InputError } from '../core.js';

const PT = 'America/Los_Angeles';

/** Today's date in Pacific Time, YYYY-MM-DD. */
export function pacificToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** YYYY-MM-DD, "today", "yesterday" or "NdaysAgo" (Pacific Time) → YYYY-MM-DD. */
export function resolveDate(value: string, today: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return value;
  if (value === 'today') return today;
  if (value === 'yesterday') return addDays(today, -1);
  const m = value.match(/^(\d+)daysAgo$/);
  if (m) return addDays(today, -Number(m[1]));
  throw new InputError(`Invalid date "${value}". Use YYYY-MM-DD, "today", "yesterday" or "NdaysAgo".`);
}

/** Default range: the 28 days ending 3 days ago, the last days with (mostly) final data. */
export const DEFAULT_START = '30daysAgo';
export const DEFAULT_END = '3daysAgo';

export function resolveRange(start: string | undefined, end: string | undefined, today: string) {
  const startDate = resolveDate(start ?? DEFAULT_START, today);
  const endDate = resolveDate(end ?? DEFAULT_END, today);
  if (startDate > endDate) throw new InputError(`start_date ${startDate} is after end_date ${endDate}.`);
  return { startDate, endDate };
}
