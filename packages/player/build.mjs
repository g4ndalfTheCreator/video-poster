import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

/** Budget for page + player + telemetry SDK (gzip), see docs/SPEC.md. */
const BUDGET = 120 * 1024;

await mkdir('dist', { recursive: true });
await build({
  entryPoints: { player: 'src/index.ts', story: 'src/story-entry.ts' },
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'safari14'],
  outdir: 'dist',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
});
// base.css on every public page; watch.css (classic layout) or story.css (story layout) on watch pages
for (const name of ['base', 'watch', 'story']) {
  await build({
    entryPoints: [`src/${name}.css`],
    bundle: true,
    minify: true,
    outfile: `dist/${name}.css`,
    logLevel: 'warning',
  });
}

const gz = async (f) => gzipSync(await readFile(f)).length;
// each page ships base.css + its layout CSS + its own bundle; the budget applies to the larger page
const classic = (await gz('dist/player.js')) + (await gz('dist/base.css')) + (await gz('dist/watch.css'));
const storyPage = (await gz('dist/story.js')) + (await gz('dist/base.css')) + (await gz('dist/story.css'));
// Largest page (story layout) measured by apps/api/test/story.test.ts, which checks the real total.
const htmlEstimate = 2.4 * 1024;
const total = Math.max(classic, storyPage) + htmlEstimate;
const report = { classic, storyPage, htmlEstimate, total, budget: BUDGET };
await writeFile('dist/size.json', JSON.stringify(report, null, 2));
console.warn(
  `classic page assets ${(classic / 1024).toFixed(1)} kB gz, story page assets ${(storyPage / 1024).toFixed(1)} kB gz, largest page ≈ ${(total / 1024).toFixed(1)} kB (budget ${BUDGET / 1024} kB)`,
);
if (total > BUDGET) {
  console.error('size budget exceeded');
  process.exit(1);
}
