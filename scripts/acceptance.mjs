import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
const { fetch, performance } = globalThis;
const preview = process.argv.includes('--preview');
const drill = process.argv.includes('--drill');
const countIndex = process.argv.indexOf('--players'),
  count = countIndex < 0 ? 3 : Number(process.argv[countIndex + 1]);
if (!Number.isInteger(count) || count < 3 || count > 350)
  throw new Error('首航验收至少使用3名玩家。');
const origin = drill
  ? 'https://recovery-drill.darkforest-pages-dev.pages.dev'
  : preview
    ? 'https://dev.darkforest-pages-dev.pages.dev'
    : 'http://127.0.0.1:5173';
const root = resolve(import.meta.dirname, '..');
const directory = resolve(
  root,
  drill ? '.private/recovery-drill' : `.private/${preview ? 'preview' : 'local'}-rehearsal`,
);
const accounts = JSON.parse(await readFile(resolve(directory, 'accounts.json'), 'utf8')).accounts;
const results = {
  origin,
  startedUtc: new Date().toISOString(),
  steps: [],
  requests: [],
  alarms: [],
};
async function request(path, body, session) {
  const started = performance.now();
  const response = await fetch(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json',
      ...(body === undefined
        ? {}
        : {
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': session?.csrf ?? '',
          }),
      ...(session ? { Cookie: session.cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  results.requests.push({
    path,
    status: response.status,
    ms: Math.round(performance.now() - started),
  });
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${data.code ?? ''} ${data.message ?? ''}`);
  return { data, response };
}
async function login(id) {
  const account = accounts.find((a) => a.id === id);
  const { data, response } = await request('/auth/exchange', {
    audience: account.role,
    credential: account.credential,
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (
    !cookie ||
    !response.headers.get('set-cookie').includes('HttpOnly') ||
    (preview && !response.headers.get('set-cookie').includes('Secure'))
  )
    throw new Error('登录Cookie属性不正确。');
  return { cookie, csrf: data.csrfToken, id };
}
async function action(path, session, payload = {}, id = randomUUID()) {
  return (await request(path, { ...payload, request_id: id }, session)).data;
}
async function manage(path, head, payload = {}) {
  const { data } = await request('/public/match');
  const reason = '后端联调验收';
  const preview = await action('/judge/manage/preview', head, {
    path,
    ...payload,
    reason,
    change: '确认本次操作',
    expected_revision: data.revision,
  });
  return action(path, head, {
    ...payload,
    reason,
    expected_revision: preview.preview.revision,
    preview_token: preview.preview.token,
  });
}
function step(name) {
  results.steps.push(name);
  console.log(name);
}
try {
  const head = await login('J01');
  const { data: initial } = await request('/public/match');
  if (initial.phase !== 'setup') throw new Error('本工具只对尚未开始的联调场次执行一次。');
  const members = Array.from({ length: count }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
  await manage('/judge/roster', head, { members });
  const { data: config } = await request('/judge/parameters', undefined, head);
  await manage('/judge/parameters', head, {
    values: { ...config.values, singerPercent: 10 },
    expected_version: config.version,
  });
  step(`正式名单选为${count}人，歌者概率保存为10%`);
  const players = await Promise.all(members.map(login));
  for (const [i, p] of players.entries()) {
    await action('/player/nickname', p, { nickname: `行星${i + 1}` });
    const code = String(600001 + i);
    await action('/action/homeworld-submit', p, { code });
    await action(`/judge/homeworld/${p.id}/verify`, head, {
      expected_version: 1,
      expected_code: code,
      decision: 'approve',
    });
    await action('/action/preflight-depart', p);
    await action('/action/preflight-stage', p);
  }
  step(`${count}名玩家分别完成登录、昵称、母星审核与首航准备`);
  const roster = { expected_roster: players.map((p) => p.id) };
  const release = Date.now() + 15000;
  await manage('/judge/arm-code-release', head, { ...roster, time: release });
  console.log('等待T0到达，期间不发送任何业务请求。');
  await setTimeout(Math.max(0, release + 12000 - Date.now()));
  const { data: released } = await request('/snapshot?route=%2Fjudge', undefined, head);
  const alarmT0 =
    released.match.stage === 'outfitting' &&
    released.judge.scheduler.lastSuccessUtcMs < released.match.serverUtcMs - 5000;
  results.alarms.push({
    kind: 'T0',
    passed: alarmT0,
    expectedUtc: release,
    lastSuccessUtc: released.judge.scheduler.lastSuccessUtcMs,
    observedServerUtc: released.match.serverUtcMs,
  });
  if (!alarmT0) throw new Error('T0未取得无人访问Alarm证据。');
  step('T0已由无人访问时的Alarm完成');
  await Promise.all(
    players.map(async (p) => {
      await action('/action/preflight-issue-code', p);
      await action('/action/preflight-ready', p);
    }),
  );
  const start = Date.now() + 15000;
  await manage('/judge/arm-start', head, { ...roster, time: start });
  console.log('等待T1到达，期间不发送任何业务请求。');
  await setTimeout(Math.max(0, start + 12000 - Date.now()));
  const { data: started } = await request('/snapshot?route=%2Fjudge', undefined, head);
  const alarmT1 =
    started.match.stage === 'forest' &&
    started.civilizations.every((c) => c.flight === 'active') &&
    started.judge.scheduler.lastSuccessUtcMs < started.match.serverUtcMs - 5000;
  results.alarms.push({
    kind: 'T1',
    passed: alarmT1,
    expectedUtc: start,
    lastSuccessUtc: started.judge.scheduler.lastSuccessUtcMs,
    observedServerUtc: started.match.serverUtcMs,
  });
  if (!alarmT1) throw new Error('T1未取得全员激活的无人访问Alarm证据。');
  step('T1已由无人访问时的Alarm全员激活');
  const target = (await request('/player/self', undefined, players[2])).data.arms;
  const hit = await action('/action/sighting', players[0], { arm_a: target[0], arm_b: target[1] });
  if (hit.outcome?.target !== 'C03') throw new Error('真实目击未命中。');
  const victim = (await request('/player/self', undefined, players[2])).data;
  if (victim.flight !== 'returning') throw new Error('目标未进入返航。');
  await action('/action/return-confirm', players[2]);
  await action('/action/issue-code', players[2]);
  await action('/action/launch', players[2]);
  step('真实目击、情报与重生出航完成');
  const cancellation = await request('/operations/late-cloud-request/resolve', {}, players[1]);
  if (cancellation.data.code !== 'CANCELLED') throw new Error('请求取消确认失败。');
  const late = await action(
    '/action/broadcast',
    players[1],
    { code: '999999' },
    'late-cloud-request',
  );
  if (late.code !== 'CANCELLED') throw new Error('迟到请求未被阻止。');
  await manage('/judge/pause', head);
  step('取消确认阻止迟到请求，联调场次已暂停供查看');
  results.completedUtc = new Date().toISOString();
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
}
const reportDirectory = resolve(root, '.private/qa');
await mkdir(reportDirectory, { recursive: true });
const report = resolve(
  reportDirectory,
  `${drill ? 'drill' : preview ? 'preview' : 'local'}-acceptance.json`,
);
await writeFile(report, JSON.stringify(results, null, 2));
console.log(`验收记录：${report}`);
