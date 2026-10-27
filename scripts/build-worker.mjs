// Bundle worker/index.js (+ src/sites.js) into dist/_worker.js and write
// dist/_routes.json so the worker only runs for page routes.
import { build } from 'rolldown';
import fs from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await build({
  input: resolve(root, 'worker/index.js'),
  output: { file: resolve(root, 'dist/_worker.js'), format: 'esm' },
  platform: 'neutral',
  logLevel: 'warn',
});
const routes = {
  version: 1,
  include: ['/*'],
  exclude: ['/assets/*', '/avatars/*', '/screenshots/*', '/videos/*', '/favicon.ico', '/games.json', '/.well-known/*', '/auth/done', '/auth/done.html'],
};
fs.writeFileSync(resolve(root, 'dist/_routes.json'), JSON.stringify(routes, null, 2) + '\n');
console.log('worker:', fs.statSync(resolve(root, 'dist/_worker.js')).size, 'bytes; routes exclude', routes.exclude.length);
