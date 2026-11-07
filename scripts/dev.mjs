import concurrently from 'concurrently';
import {randomUUID} from 'node:crypto';
import {mkdir, readdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import process from 'node:process';
import console from 'node:console';

// A stopped Wrangler process can leave its RPC address registered for 90 seconds.
// Share a fresh discovery directory for this run; keep DO storage in .wrangler/state.
const root = resolve(import.meta.dirname, '..');
const registryRoot = resolve(root, '.wrangler/dev-registry');
await mkdir(registryRoot, {recursive: true});
// Only reap this launcher's directories, and only if their owner has exited.
for (const entry of await readdir(registryRoot, {withFileTypes: true})) {
  const owner = /^session-(\d+)-[0-9a-f-]{36}$/.exec(entry.name);
  if (!entry.isDirectory() || !owner) {
    continue;
  }
  try {
    process.kill(Number(owner[1]), 0);
  } catch (error) {
    if (error.code === 'ESRCH') {
      await rm(resolve(registryRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
}
const registry = resolve(
  registryRoot,
  `session-${process.pid}-${randomUUID()}`,
);
const env = {
  ...process.env,
  WRANGLER_REGISTRY_PATH: registry,
  CLOUDFLARE_DEV_REGISTRY_PATH: registry,
};
const {result} = concurrently(
  [
    {command: 'npm run dev:core', name: 'core', env},
    {command: 'npm run dev:pages', name: 'pages', env},
    {command: 'npm run dev:web', name: 'web', env},
  ],
  {
    cwd: root,
    killOthersOn: ['success', 'failure'],
    prefixColors: ['cyan', 'magenta', 'green'],
  },
);

try {
  await result;
} catch {
  process.exitCode = 1;
} finally {
  await rm(registry, {recursive: true, force: true}).catch(error => {
    console.warn(`本次开发连接目录未能清理，下次启动会重试：${error.message}`);
  });
}
