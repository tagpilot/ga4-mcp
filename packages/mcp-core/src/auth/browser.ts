import { spawn } from 'node:child_process';

/** Best effort: the URL is always printed to stderr and returned to the client as well. */
export function openBrowser(url: string, preferred?: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = preferred ? ['-a', preferred, url] : [url];
  } else if (process.platform === 'win32') {
    cmd = preferred || 'cmd';
    args = preferred ? [url] : ['/c', 'start', '""', url.replace(/&/g, '^&')];
  } else {
    cmd = preferred || 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}
