import {readFile, writeFile, mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import console from 'node:console';
import process from 'node:process';

const {fetch} = globalThis;
const origin = 'https://recovery-drill.darkforest-pages-dev.pages.dev';
const folder = '.private/recovery-drill';
const secrets = JSON.parse(await readFile(`${folder}/secrets.json`, 'utf8'));
const accounts = JSON.parse(
  await readFile(`${folder}/accounts.json`, 'utf8'),
).accounts;
const evidence = {origin, startedUtc: new Date().toISOString(), steps: []};
async function api(path, body, session) {
  const response = await fetch(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined
        ? {}
        : {
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': session?.csrf ?? '',
          }),
      ...(session ? {Cookie: session.cookie} : {}),
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const data = await response.json();
  return {status: response.status, data, response};
}
async function login(id) {
  const a = accounts.find(a => a.id === id);
  const r = await api('/auth/exchange', {
    credential: a.credential,
    audience: a.role,
  });
  assert.equal(r.status, 200);
  return {
    cookie: r.response.headers.get('set-cookie').split(';')[0],
    csrf: r.data.csrfToken,
  };
}
async function action(path, head, payload = {}) {
  const r = await api(path, {...payload, request_id: randomUUID()}, head);
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.data)}`);
  return r.data;
}
async function manage(path, head, payload) {
  const current = await api('/public/match');
  const reason = '独立云端PITR恢复演练';
  const preview = await action('/judge/manage/preview', head, {
    path,
    ...payload,
    reason,
    expected_revision: current.data.revision,
  });
  return action(path, head, {
    ...payload,
    reason,
    expected_revision: preview.preview.revision,
    preview_token: preview.preview.token,
  });
}
async function operator(operation, payload) {
  const response = await fetch(`${origin}/api/recovery`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secrets.BOOTSTRAP_SECRET}`,
    },
    body: JSON.stringify({operation, payload}),
  });
  return {status: response.status, data: await response.json()};
}
function step(value) {
  evidence.steps.push(value);
  console.log(value);
}
try {
  let head = await login('J01');
  const oldPlayer = await login('C01');
  const initial = await api('/snapshot?route=/judge', undefined, head);
  assert.equal(initial.data.match.paused, true);
  evidence.initialIssued = initial.data.judge.issuedCodes;
  const exported = await api('/judge/export?kind=checkpoint', undefined, head);
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  const checkpoint = JSON.parse(exported.data.text);
  await writeFile(`${folder}/target-checkpoint.json`, exported.data.text, {
    flag: 'wx',
  });
  step('保存带原生PITR书签的恢复检查点');
  await manage('/judge/equipment-correction', head, {
    target: 'C01',
    mode: 'reissue',
  });
  await manage('/judge/equipment-correction', head, {
    target: 'C01',
    mode: 'activate',
  });
  const latest = await api('/snapshot?route=/judge', undefined, head);
  evidence.latestIssued = latest.data.judge.issuedCodes;
  assert.equal(evidence.latestIssued, evidence.initialIssued + 1);
  step('检查点之后再次换码，制造必须保全的发行记录');
  const prepared = await operator('prepare', {
    target: checkpoint,
    reason: '独立云端PITR恢复演练',
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const carry = prepared.data;
  await writeFile(`${folder}/preserved-carry.json`, JSON.stringify(carry), {
    flag: 'wx',
  });
  step('恢复前完整发行历史及证据已加密保存');
  try {
    const launch = await operator('launch', carry);
    evidence.launchStatus = launch.status;
  } catch {
    evidence.launchStatus = 'connection-closed-by-object-restart';
  }
  let status;
  for (let attempt = 0; attempt < 10; attempt++) {
    await setTimeout(2000);
    status = await operator('status');
    if (status.status === 200 && status.data.state === checkpoint.marker) {
      break;
    }
  }
  assert.equal(status.status, 200);
  assert.equal(status.data.state, checkpoint.marker);
  evidence.nativeRestoredState = status.data;
  step('Cloudflare原生PITR已恢复到检查点，恢复状态标记一致');
  const completed = await operator('complete', carry);
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  assert.equal(completed.data.issuedCount, evidence.latestIssued);
  assert.equal((await api('/player/self', undefined, oldPlayer)).status, 401);
  head = await login('J01');
  const restored = await api('/snapshot?route=/judge', undefined, head);
  assert.equal(restored.data.match.recoveryReview, true);
  assert.equal(restored.data.match.paused, true);
  assert.equal(restored.data.judge.issuedCodes, evidence.latestIssued);
  step('历史发行全部保留、旧会话失效、比赛保持暂停');
  await manage('/judge/equipment-correction', head, {
    target: 'C01',
    mode: 'reissue',
  });
  await manage('/judge/equipment-correction', head, {
    target: 'C01',
    mode: 'activate',
  });
  await manage('/judge/recovery-finalize', head, {});
  const final = await api('/snapshot?route=/judge', undefined, head);
  assert.equal(final.data.match.recoveryReview, false);
  assert.equal(final.data.match.paused, true);
  assert.equal(final.data.judge.issuedCodes, evidence.latestIssued + 1);
  evidence.finalIssued = final.data.judge.issuedCodes;
  step('使用全新配置恢复穿戴并完成恢复核对，仍保持暂停供后续测试');
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
}
evidence.completedUtc = new Date().toISOString();
await mkdir('.private/qa', {recursive: true});
await writeFile(
  '.private/qa/native-pitr-drill.json',
  JSON.stringify(evidence, null, 2),
);
