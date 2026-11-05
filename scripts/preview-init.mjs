import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import console from 'node:console';
const { fetch } = globalThis;
const directory = resolve(import.meta.dirname, '../.private/preview-rehearsal');
const { BOOTSTRAP_SECRET } = JSON.parse(await readFile(resolve(directory, 'secrets.json'), 'utf8'));
const body = await readFile(resolve(directory, 'bootstrap.json'), 'utf8');
const response = await fetch('https://dev.darkforest-pages-dev.pages.dev/api/bootstrap', {
  method: 'POST',
  headers: {
    Origin: 'https://dev.darkforest-pages-dev.pages.dev',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${BOOTSTRAP_SECRET}`,
  },
  body,
});
const result = await response.json();
if (!response.ok) throw new Error(`${response.status}: ${result.message ?? result.code}`);
console.log(JSON.stringify(result));
