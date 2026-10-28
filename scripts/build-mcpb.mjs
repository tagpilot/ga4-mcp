// Builds a Claude Desktop extension: packages/<name>/tagpilot-<name>-<version>.mcpb (plus a copy under
// the stable release asset name tagpilot-<name>.mcpb). The server is ONE bundled file (core, MCP SDK
// and zod inlined), so Claude Desktop runs it with its built-in Node: no npx, no node_modules.
// Usage: node scripts/build-mcpb.mjs <package-name>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from './build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const name = process.argv[2];
if (!name) throw new Error('usage: node scripts/build-mcpb.mjs <package-name>');
const dir = path.join(root, 'packages', name);
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mcpb/manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`mcpb/manifest.json is ${manifest.version}, package.json is ${pkg.version}`);

const stage = path.join(dir, 'build-mcpb');
const out = path.join(dir, `tagpilot-${name}-${pkg.version}.mcpb`);
const stable = path.join(dir, `tagpilot-${name}.mcpb`);
const mcpb = path.join(root, 'node_modules/.bin/mcpb');
const run = (args) => execFileSync(mcpb, args, { cwd: root, stdio: 'inherit' });

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);
fs.cpSync(path.join(dir, 'mcpb'), stage, { recursive: true });
await buildPackage(name, { bundleDependencies: true, outfile: path.join(stage, 'server/index.js') });
for (const f of ['README.md', 'LICENSE', 'NOTICE']) fs.copyFileSync(path.join(dir, f), path.join(stage, f));
const { description, license, type } = pkg;
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description, license, type }, null, 2) + '\n');

run(['validate', path.join(stage, 'manifest.json')]);
fs.rmSync(out, { force: true });
run(['pack', stage, out]);
run(['info', out]);
fs.copyFileSync(out, stable);
console.log(`\nBuilt ${path.relative(root, out)} (+ copy ${path.basename(stable)} for the GitHub release). Check it with: npm run mcpb:smoke`);
