import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

/** Budget for page + player + telemetry SDK (gzip), see docs/SPEC.md. */
const BUDGET = 120 * 1024;

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'safari14'],
  outfile: 'dist/player.js',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
});
await build({
  entryPoints: ['src/player.css'],
  bundle: true,
  minify: true,
  outfile: 'dist/player.css',
  logLevel: 'warning',
});

const js = gzipSync(await readFile('dist/player.js')).length;
const css = gzipSync(await readFile('dist/player.css')).length;
const htmlEstimate = 3 * 1024;
const total = js + css + htmlEstimate;
const report = { js, css, htmlEstimate, total, budget: BUDGET };
await writeFile('dist/size.json', JSON.stringify(report, null, 2));
console.warn(
  `player.js ${(js / 1024).toFixed(1)} kB gz, player.css ${(css / 1024).toFixed(1)} kB gz, total ≈ ${(total / 1024).toFixed(1)} kB (budget ${BUDGET / 1024} kB)`,
);
if (total > BUDGET) {
  console.error('size budget exceeded');
  process.exit(1);
}
