import {readFile} from 'node:fs/promises';
import console from 'node:console';
import {resolve} from 'node:path';

const {fetch} = globalThis;
const root = resolve(import.meta.dirname, '..');
const vars = await readFile(
  resolve(root, 'apps/match-worker/.dev.vars'),
  'utf8',
);
const secret = /^BOOTSTRAP_SECRET=(.+)$/m.exec(vars)?.[1]?.trim();
if (!secret) {
  throw new Error('请先运行npm run local:setup。');
}
const payload = await readFile(
  resolve(root, '.private/local-rehearsal/bootstrap.json'),
  'utf8',
);
const response = await fetch('http://127.0.0.1:8787/__bootstrap', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${secret}`,
  },
  body: payload,
});
const result = await response.json();
if (!response.ok) {
  throw new Error(`${response.status}: ${result.message ?? result.code}`);
}
console.log(
  `场次${result.matchId}初始化完成，schema版本${result.schemaVersion}。`,
);
