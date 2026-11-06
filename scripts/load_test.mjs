import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import process from 'node:process';
import console from 'node:console';
const {fetch, performance} = globalThis;
const args = process.argv.slice(2);
const option = (name, defaultValue) => {
  const i = args.indexOf(name);
  return i < 0 ? defaultValue : args[i + 1];
};
const origin = option('--origin', 'http://127.0.0.1:5173');
const accountsPath = option(
  '--accounts',
  '.private/local-rehearsal/accounts.json',
);
const seconds = Number(option('--seconds', '60'));
const n = Number(option('--players', '24'));
if (
  !Number.isInteger(seconds) ||
  seconds < 10 ||
  seconds > 900 ||
  !Number.isInteger(n) ||
  n < 2 ||
  n > 350
) {
  throw new Error('负载测试时长为10—900秒，玩家数为2—350。');
}
const accounts = JSON.parse(
  await readFile(resolve(accountsPath), 'utf8'),
).accounts;
const players = accounts.filter(a => a.role === 'player').slice(0, n);
const judges = accounts.filter(a => a.role === 'judge');
if (players.length !== n || judges.length !== 3) {
  throw new Error('账号文件没有足够的玩家及3名独立裁判。');
}
const samples = [];
const errors = [];
const sessions = [];
const started = Date.now();
for (const account of [...players, ...judges]) {
  const response = await fetch(`${origin}/api/auth/exchange`, {
    method: 'POST',
    headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      credential: account.credential,
      audience: account.role,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`登录失败：${response.status} ${data.code}`);
  }
  sessions.push({
    id: account.id,
    role: account.role,
    cookie: response.headers.get('set-cookie').split(';')[0],
  });
}
const head = sessions.find(s => s.id === 'J01');
const clients = [
  ...sessions.map(s => ({
    ...s,
    route: s.role === 'judge' ? '/judge' : '/player',
    interval: s.role === 'judge' ? 3000 : 2000,
  })),
  {...head, route: '/display', interval: 5000},
];
const until = performance.now() + seconds * 1000;
await Promise.all(
  clients.map(async client => {
    while (performance.now() < until) {
      const begin = performance.now();
      try {
        const response = await fetch(
          `${origin}/api/snapshot?route=${encodeURIComponent(client.route)}`,
          {headers: {Cookie: client.cookie}},
        );
        const data = await response.json();
        samples.push({status: response.status, ms: performance.now() - begin});
        if (!response.ok) {
          errors.push({
            status: response.status,
            code: data.code,
            id: client.id,
          });
        }
      } catch (e) {
        samples.push({status: 0, ms: performance.now() - begin});
        errors.push({id: client.id, error: e.message});
      }
      const remain = client.interval - (performance.now() - begin);
      if (remain > 0) {
        await setTimeout(
          Math.min(remain, Math.max(0, until - performance.now())),
        );
      }
    }
  }),
);
const times = samples.map(s => s.ms).sort((a, b) => a - b);
const percentile = p =>
  Math.round(
    times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0,
  );
const result = {
  origin,
  startedUtc: new Date(started).toISOString(),
  finishedUtc: new Date().toISOString(),
  players: n,
  judges: 3,
  displays: 1,
  durationSeconds: seconds,
  requests: samples.length,
  errorCount: errors.length,
  errorRate: errors.length / Math.max(1, samples.length),
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  errors,
};
await mkdir('.private/qa', {recursive: true});
const output = option('--output', `.private/qa/load-${Date.now()}.json`);
await writeFile(resolve(output), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (errors.length) {
  process.exitCode = 1;
}
