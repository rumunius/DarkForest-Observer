import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import console from 'node:console';
const root = resolve(import.meta.dirname, '..'),
  path = resolve(root, 'apps/match-worker/.dev.vars');
let vars = await readFile(path, 'utf8').catch(() => '');
for (const key of [
  'CODE_HMAC_KEY',
  'CODE_ENCRYPTION_KEY',
  'BOOTSTRAP_SECRET',
  'PLATFORM_BOOTSTRAP_SECRET',
]) {
  if (!new RegExp(`^${key}=.+$`, 'm').test(vars))
    vars += `${vars && !vars.endsWith('\n') ? '\n' : ''}${key}=${randomBytes(32).toString(key.includes('SECRET') ? 'base64url' : 'base64')}\n`;
}
await writeFile(path, vars, { mode: 0o600 });
const directory = resolve(root, '.private/platform-admin');
await mkdir(directory, { recursive: true, mode: 0o700 });
const maintenanceSecret = vars.match(/^PLATFORM_BOOTSTRAP_SECRET=(.+)$/m)[1].trim();
await writeFile(
  resolve(directory, '127.0.0.1.environment.json'),
  JSON.stringify({ origin: 'http://127.0.0.1:8788', maintenanceSecret }, null, 2),
  { mode: 0o600, flag: 'wx' },
).catch((error) => {
  if (error.code !== 'EEXIST') throw error;
});
console.log(
  '本地平台密钥已配置，已有密钥保留。运行 npm run dev 后，再运行 npm run admin:wizard，在网站领取首次所有者账号。',
);
