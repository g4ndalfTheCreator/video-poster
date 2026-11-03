import { cp } from 'node:fs/promises';
import { buildNodeApp } from '../../scripts/build-node.mjs';

await buildNodeApp({ appDir: import.meta.dirname, entries: ['src/main.ts'] });
await cp('../../packages/core/src/migrations', 'dist/migrations', { recursive: true });
