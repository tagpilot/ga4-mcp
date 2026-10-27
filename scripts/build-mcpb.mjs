// Builds the Claude Desktop extension: tagpilot-ga4-mcp-<version>.mcpb (and a copy under the stable
// release asset name tagpilot-ga4-mcp.mcpb). The bundle holds the built server plus production
// node_modules, so Claude Desktop runs it with its built-in Node: no npx, no Node install.
// Run: npm run mcpb   (builds dist/ first)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mcpb/manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`mcpb/manifest.json is ${manifest.version}, package.json is ${pkg.version}`);

const stage = path.join(root, 'build-mcpb');
const out = path.join(root, `tagpilot-ga4-mcp-${pkg.version}.mcpb`);
const stable = path.join(root, 'tagpilot-ga4-mcp.mcpb');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const mcpb = path.join(root, 'node_modules/.bin/mcpb');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);
fs.cpSync(path.join(root, 'mcpb'), stage, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'server'), { recursive: true });
for (const f of ['README.md', 'LICENSE', 'NOTICE', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(stage, f));
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
// Then keep only what Node needs to run the server: ESM + the runtime dependencies.
const { name, version, description, license, type, dependencies } = pkg;
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name, version, description, license, type, dependencies }, null, 2) + '\n');
fs.rmSync(path.join(stage, 'package-lock.json'));

run(mcpb, ['validate', path.join(stage, 'manifest.json')]);
fs.rmSync(out, { force: true });
run(mcpb, ['pack', stage, out]);
run(mcpb, ['info', out]);
fs.copyFileSync(out, stable);
console.log(`\nBuilt ${path.basename(out)} (+ copy ${path.basename(stable)} for the GitHub release). Check it with: npm run mcpb:smoke`);
