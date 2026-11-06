import {randomBytes, createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import process from 'node:process';
import console from 'node:console';
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, '.private/preview-rehearsal');
const count = Number(process.argv[2] ?? 24);
if (!Number.isInteger(count) || count < 2 || count > 350) {
  throw new Error('账号数量须为2—350之间的整数。');
}
await mkdir(directory, {recursive: true});
const secrets = {
  CODE_HMAC_KEY: randomBytes(32).toString('base64'),
  CODE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  BOOTSTRAP_SECRET: randomBytes(32).toString('base64url'),
};
await writeFile(resolve(directory, 'secrets.json'), JSON.stringify(secrets), {
  flag: 'wx',
  mode: 0o600,
});
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
].map(a => ({...a, credential: randomBytes(32).toString('base64url')}));
await writeFile(
  resolve(directory, 'accounts.json'),
  JSON.stringify({match_id: 'preview-rehearsal', accounts}, null, 2),
  {flag: 'wx', mode: 0o600},
);
await writeFile(
  resolve(directory, 'bootstrap.json'),
  JSON.stringify({
    match_id: 'preview-rehearsal',
    accounts: accounts.map(({credential, ...a}) => ({
      ...a,
      credential_hash: createHash('sha256').update(credential).digest('base64'),
    })),
  }),
  {flag: 'wx', mode: 0o600},
);
console.log(
  `已生成${count}个preview玩家账号及3个裁判账号。私有文件：${directory}`,
);
