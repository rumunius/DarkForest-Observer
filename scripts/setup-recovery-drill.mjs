import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import console from 'node:console';
const root = resolve(import.meta.dirname, '..'),
  directory = resolve(root, '.private/recovery-drill'),
  site = resolve(directory, 'site');
await mkdir(site, { recursive: true });
const exists = await access(resolve(directory, 'secrets.json')).then(
  () => true,
  () => false,
);
if (exists) throw new Error('恢复演练配置已存在，未覆盖。');
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
  ...Array.from({ length: 24 }, (_, i) => ({
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
].map((a) => ({ ...a, credential: randomBytes(32).toString('base64url') }));
await writeFile(
  resolve(directory, 'accounts.json'),
  JSON.stringify({ match_id: 'recovery-drill', accounts }, null, 2),
  { flag: 'wx', mode: 0o600 },
);
await writeFile(
  resolve(directory, 'bootstrap.json'),
  JSON.stringify({
    match_id: 'recovery-drill',
    accounts: accounts.map(({ credential, ...a }) => ({
      ...a,
      credential_hash: createHash('sha256').update(credential).digest('base64'),
    })),
  }),
  { flag: 'wx', mode: 0o600 },
);
const worker = {
  name: 'darkforest-core-recovery-drill',
  main: resolve(root, 'apps/match-worker/src/index.ts').replaceAll('\\', '/'),
  compatibility_date: '2026-11-01',
  workers_dev: false,
  preview_urls: false,
  version_metadata: { binding: 'CF_VERSION_METADATA' },
  vars: { APP_ENV: 'preview', MATCH_ID: 'recovery-drill' },
  durable_objects: { bindings: [{ name: 'MATCH_DO', class_name: 'DarkForestMatch' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['DarkForestMatch'] }],
};
await writeFile(resolve(directory, 'worker.json'), JSON.stringify(worker, null, 2));
const pages = {
  name: 'darkforest-pages-dev',
  pages_build_output_dir: resolve(root, 'apps/web/dist').replaceAll('\\', '/'),
  compatibility_date: '2026-11-01',
  vars: {
    APP_ENV: 'preview',
    MATCH_ID: 'recovery-drill',
    TRUSTED_ORIGINS: 'https://recovery-drill.darkforest-pages-dev.pages.dev',
  },
  durable_objects: {
    bindings: [
      {
        name: 'MATCH_DO',
        class_name: 'DarkForestMatch',
        script_name: 'darkforest-core-recovery-drill',
      },
    ],
  },
  env: {
    preview: {
      vars: {
        APP_ENV: 'preview',
        MATCH_ID: 'recovery-drill',
        TRUSTED_ORIGINS: 'https://recovery-drill.darkforest-pages-dev.pages.dev',
      },
      durable_objects: {
        bindings: [
          {
            name: 'MATCH_DO',
            class_name: 'DarkForestMatch',
            script_name: 'darkforest-core-recovery-drill',
          },
        ],
      },
    },
  },
};
await writeFile(resolve(site, 'wrangler.json'), JSON.stringify(pages, null, 2));
console.log(`独立恢复演练配置：${directory}`);
