import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await writeFile('dist/player.js', '// placeholder\n');
