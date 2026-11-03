// Shared esbuild config for node apps: bundles workspace (@vs/*) sources, keeps npm deps external.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function buildNodeApp({ appDir, entries, outdir = 'dist' }) {
  // Only the app's own dependencies are resolvable at runtime (pnpm strict layout); apps must
  // therefore list the runtime deps of the workspace packages they use.
  const pkgs = [appDir];
  const external = new Set();
  for (const p of pkgs) {
    const pkg = JSON.parse(readFileSync(path.join(p, 'package.json'), 'utf8'));
    for (const d of Object.keys(pkg.dependencies ?? {})) if (!d.startsWith('@vs/')) external.add(d);
  }
  await build({
    entryPoints: entries,
    absWorkingDir: appDir,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outdir,
    sourcemap: true,
    external: [...external].flatMap((d) => [d, `${d}/*`]),
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'warning',
  });
}
