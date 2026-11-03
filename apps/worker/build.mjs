import { buildNodeApp } from '../../scripts/build-node.mjs';

await buildNodeApp({ appDir: import.meta.dirname, entries: ['src/main.ts', 'src/seed.ts'] });
