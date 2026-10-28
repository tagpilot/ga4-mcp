// Builds the published packages: packages/<name>/src/index.ts → packages/<name>/dist/index.js, one
// ESM file with the shared core (packages/mcp-core) bundled in. The package's own dependencies
// (MCP SDK, zod) stay external and are installed by npm.
// Usage: node scripts/build.mjs [package-name ...]   (default: all published packages)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PUBLISHED = ['ga4-mcp', 'search-console-mcp'];

export async function buildPackage(name, { bundleDependencies = false, outfile } = {}) {
  const dir = path.join(root, 'packages', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const out = outfile ?? path.join(dir, 'dist/index.js');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  await build({
    entryPoints: [path.join(dir, 'src/index.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    // npm installs the dependencies; the .mcpb bundles everything (no node_modules in the extension).
    external: bundleDependencies ? [] : Object.keys(pkg.dependencies ?? {}),
    // Bundled CommonJS dependencies (ajv in the MCP SDK) call require().
    banner: bundleDependencies ? { js: "import { createRequire as __tpCreateRequire } from 'node:module'; const require = __tpCreateRequire(import.meta.url);" } : undefined,
    legalComments: 'none',
    logLevel: 'warning',
  });
  fs.chmodSync(out, 0o755);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : PUBLISHED;
  for (const name of names) console.log(`built ${path.relative(root, await buildPackage(name))}`);
}
