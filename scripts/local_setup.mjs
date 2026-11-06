import {randomBytes, createHash} from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
import {mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const flags = process.argv.slice(2);
const countIndex = flags.indexOf('--players');
const count = Number(countIndex < 0 ? 24 : flags[countIndex + 1]);
if (!Number.isInteger(count) || count < 2 || count > 350) {
  throw new Error('--players须为2—350之间的整数');
}
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}
const varsPath = resolve(root, 'apps/match-worker/.dev.vars');
let vars;
if (await exists(varsPath)) {
  vars = await readFile(varsPath, 'utf8');
} else {
  vars = `CODE_HMAC_KEY=${randomBytes(32).toString('base64')}\nCODE_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nBOOTSTRAP_SECRET=${randomBytes(32).toString('base64url')}\n`;
  await writeFile(varsPath, vars, {flag: 'wx', mode: 0o600});
}
for (const key of [
  'CODE_HMAC_KEY',
  'CODE_ENCRYPTION_KEY',
  'BOOTSTRAP_SECRET',
]) {
  if (!new RegExp(`^${key}=.+$`, 'm').test(vars)) {
    throw new Error(`${key}未配置；请在Worker本地.dev.vars中配置。`);
  }
}
const directory = resolve(root, '.private/local-rehearsal');
await mkdir(directory, {recursive: true});
const accountsPath = resolve(directory, 'accounts.json');
if (await exists(accountsPath)) {
  throw new Error('账号发放文件已存在，未覆盖。可直接运行npm run local:init。');
}
const accounts = [
  ...Array.from({length: count}, (_, i) => ({
    id: `C${String(i + 1).padStart(2, '0')}`,
    role: 'player',
    name: `文明${i + 1}`,
  })),
  ...['head', 'communications', 'events'].map((duty, i) => ({
    id: `J0${i + 1}`,
    role: 'judge',
    name: ['总裁判', '通讯裁判', '事件裁判'][i],
    duty,
  })),
].map(account => ({
  ...account,
  credential: randomBytes(32).toString('base64url'),
}));
await writeFile(
  accountsPath,
  JSON.stringify({match_id: 'local-rehearsal', accounts}, null, 2),
  {
    flag: 'wx',
    mode: 0o600,
  },
);
const payload = {
  match_id: 'local-rehearsal',
  accounts: accounts.map(({credential, ...account}) => ({
    ...account,
    credential_hash: createHash('sha256').update(credential).digest('base64'),
  })),
};
await writeFile(
  resolve(directory, 'bootstrap.json'),
  JSON.stringify(payload, null, 2),
  {
    flag: 'wx',
    mode: 0o600,
  },
);
console.log(`已建立${count}名玩家及3名独立裁判。账号文件：${accountsPath}`);
console.log('运行npm run dev，再在另一终端运行npm run local:init。');
