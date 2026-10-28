// Renders the connect flow on stderr. On an interactive terminal (TTY, NO_COLOR unset, TERM not
// "dumb"): a block with the link, a big boxed code, a spinner with a countdown, and a ✔/✖ result.
// Otherwise (MCP hosts capture stderr into log files): plain ASCII lines with the product prefix.
import type { ConnectEvent } from './auth/token-manager.js';
import { logName } from './log.js';
import type { Product } from './product.js';

export interface Output {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface RendererOptions {
  product: Product;
  stream?: Output;
  env?: NodeJS.ProcessEnv;
  /** Animate a spinner + countdown (the `login` command). Off for the MCP server. */
  animate?: boolean;
  /** What to tell the user after a failure, e.g. "Run `npx -y @tagpilot/ga4-mcp login` to try again." */
  retryHint: string;
  now?: () => number;
}

export function fancyTerminal(stream: Output, env: NodeJS.ProcessEnv): boolean {
  return Boolean(stream.isTTY) && !('NO_COLOR' in env && env.NO_COLOR !== '') && env.TERM !== 'dumb';
}

const ESC = '\x1b[';
const style = (codes: string) => (s: string) => `${ESC}${codes}m${s}${ESC}0m`;
const bold = style('1');
const dim = style('2');
const cyan = style('36');
const link = style('4;36');
const green = style('1;32');
const red = style('1;31');
const yellow = style('33');
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "3J79-H7JH" → boxed, letter-spaced, for reading off one screen and typing on another. */
export function codeBox(code: string, indent = '     '): string[] {
  const spaced = code.split('').join(' ').replace(/ - /g, '  –  ');
  const inner = `   ${spaced}   `;
  const width = [...inner].length;
  return [`${indent}┌${'─'.repeat(width)}┐`, `${indent}│${bold(cyan(inner))}│`, `${indent}└${'─'.repeat(width)}┘`];
}

function failureText(e: Extract<ConnectEvent, { type: 'failed' }>): string {
  if (e.reason === 'denied') return 'Connecting was denied or cancelled.';
  if (e.reason === 'expired') return 'The code expired before it was approved.';
  if (e.reason === 'cancelled') return 'Connecting was cancelled.';
  return `Connecting failed: ${e.message}`;
}

export function createConnectRenderer(o: RendererOptions): { handle(e: ConnectEvent): void; stop(): void } {
  const out = o.stream ?? process.stderr;
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const fancy = fancyTerminal(out, env);
  const p = o.product;
  let timer: NodeJS.Timeout | undefined;
  let frame = 0;
  let spinning = false;

  const stopSpinner = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (spinning) out.write(`\r${ESC}2K`);
    spinning = false;
  };
  const plain = (lines: string[]) => out.write(lines.map((l) => `[${logName()}] ${l}`).join('\n') + '\n');

  return {
    stop: stopSpinner,
    handle(e) {
      if (!fancy) {
        if (e.type === 'started') {
          const mins = Math.max(1, Math.round((e.expiresAt - now()) / 60_000));
          plain(
            e.kind === 'device'
              ? [
                  `Tag Pilot - ${p.label}: connect this computer to your free Tag Pilot account.`,
                  `  Open: ${e.url}`,
                  `  Or go to ${e.verificationUri} and enter the code: ${e.userCode}`,
                  `  Then allow ${p.googleAccess}. Waiting for approval (expires in ${mins} min).`,
                ]
              : [`Tag Pilot - ${p.label}: sign in with Google (TAGPILOT_API_KEY).`, `  Open: ${e.url}`, `  Waiting for approval (expires in ${mins} min).`],
          );
        } else if (e.type === 'connected') {
          plain([`Connected as device '${e.label}'.`]);
        } else {
          plain([failureText(e), `  ${o.retryHint}`]);
        }
        return;
      }

      if (e.type === 'started') {
        const lines = ['', `  ${bold(`Tag Pilot · ${p.label}`)}`];
        if (e.kind === 'device') {
          lines.push(
            `  ${dim('Connect this computer to your free Tag Pilot account.')}`,
            '',
            `  ${bold('1')}  Open this link (any browser, any device):`,
            `     ${link(e.url)}`,
            '',
            `  ${bold('2')}  Check that it shows this code, then approve:`,
            '',
            ...codeBox(e.userCode ?? ''),
            '',
            `     ${dim(`On another device? Go to ${e.verificationUri} and type the code.`)}`,
            '',
            `  ${bold('3')}  Allow ${p.googleAccess}.`,
            '',
          );
        } else {
          lines.push(`  ${dim('Sign in with Google for TAGPILOT_API_KEY.')}`, '', `  Open this link (any browser, any device):`, `     ${link(e.url)}`, '');
        }
        out.write(lines.join('\n') + '\n');
        const expiresAt = e.expiresAt;
        if (o.animate) {
          const draw = () => {
            out.write(`\r${ESC}2K  ${cyan(SPINNER[frame++ % SPINNER.length])} Waiting for approval…  ${dim(`expires in ${mmss(expiresAt - now())}`)}`);
          };
          spinning = true;
          draw();
          timer = setInterval(draw, 100);
          timer.unref();
        } else {
          out.write(`  ${yellow('…')} Waiting for approval ${dim(`(expires in ${mmss(expiresAt - now())})`)}\n`);
        }
      } else if (e.type === 'connected') {
        stopSpinner();
        out.write(`  ${green('✔')} Connected as device ${bold(`'${e.label}'`)}\n\n`);
      } else {
        stopSpinner();
        out.write(`  ${red('✖')} ${failureText(e)}\n     ${o.retryHint}\n\n`);
      }
    },
  };
}
