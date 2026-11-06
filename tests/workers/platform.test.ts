import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import type { BackendEnv, RpcInput } from '../../apps/match-worker/src/rpc/types';
import type { PlatformSession } from '@darkforest/contracts';
import { Store } from '../../apps/match-worker/src/storage/store';
import { Engine } from '../../apps/match-worker/src/services/engine';
import { archiveReport, finish } from '../../apps/match-worker/src/services/life';
import { gateway } from '../../apps/web/functions/_lib/gateway';
import { digest } from '../../apps/match-worker/src/security/crypto';
import { stableJson } from '../../packages/contracts/src/backend';
import { totp } from '../../apps/match-worker/src/platform/security';
import { DarkForestPlatform } from '../../apps/match-worker/src/platform/platform';
import {
  createCheckpoint,
  openCheckpoint,
  restoreCheckpointTables,
} from '../../apps/match-worker/src/services/recovery';

const bindings = env as unknown as BackendEnv;
const platform = () => bindings.PLATFORM_DO!.getByName('platform:primary');
type Login = { token: string; session: PlatformSession; credential: string };
let owner: Login;
async function ageSession(login = owner, age = 3600000) {
  const hash = await digest(login.token),
    created = Date.now() - age;
  await runInDurableObject(platform(), (_instance, state) =>
    new Store(state.storage).exec(
      'UPDATE platform_sessions SET created_utc=?,expires=?,reauth_utc=0 WHERE token_hash=?',
      created,
      created + 43200000,
      hash,
    ),
  );
}
async function call(path: string, body?: unknown, login = owner) {
  const input: RpcInput = {
    method: body === undefined ? 'GET' : 'POST',
    path,
    edgeUtc: Date.now(),
    clientKey: 'platform-test',
    ...(body === undefined ? {} : { body }),
    ...(login ? { token: login.token, csrf: login.session.csrfToken } : {}),
  };
  const reply = await platform().call(input);
  return { ...reply, body: JSON.parse(reply.body) };
}
async function activate(invitation: string, kind = 'staff'): Promise<Login> {
  const claim = await call('/auth/claim', { invitation });
  expect(claim.status, JSON.stringify(claim.body)).toBe(200);
  const credential = claim.body.credential as string;
  const login = await call('/auth/exchange', { credential, audience: kind });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { token: login.sessionToken!, session: login.body, credential };
}
async function account(name: string, kind = 'staff') {
  const create = await call('/platform/accounts/create', {
    request_id: crypto.randomUUID(),
    name,
    kind,
    reason: '测试创建长期账号',
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  return activate(create.body.invitation, kind);
}
async function drain() {
  await runInDurableObject(platform(), (instance) => instance.alarm());
}
async function match(name: string, kind = 'official', request_id = crypto.randomUUID()) {
  const reply = await call('/platform/matches/create', {
    request_id,
    name,
    kind,
    retentionConfirmed: true,
    reason: '测试创建独立比赛',
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  await drain();
  const op = await call(`/platform/operations/${request_id}`);
  expect(op.body.status, JSON.stringify(op.body)).toBe('succeeded');
  return reply.body.matchId as string;
}
async function invite(id: string, login: Login) {
  const reply = await call(`/matches/${id}/members/invite`, {
    request_id: crypto.randomUUID(),
    accountId: login.session.account.id,
    reason: '测试本场邀请',
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  await drain();
  const accept = await call(
    `/matches/${id}/members/accept`,
    { request_id: crypto.randomUUID(), consent: true, reason: '本人接受比赛与数据期限' },
    login,
  );
  expect(accept.status, JSON.stringify(accept.body)).toBe(202);
  await drain();
}
async function bind(id: string, login: Login) {
  await invite(id, login);
}
async function assign(id: string, login: Login, seat: string, expectedVersion = 0) {
  const body = {
    accountId: login.session.account.id,
    seat,
    expectedVersion,
    reason: '核对岗位交接',
    matchId: id,
    takeover: true,
  };
  const preview = await call('/platform/preview', {
    path: `/matches/${id}/staff/assign`,
    payload: body,
  });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const reply = await call(`/matches/${id}/staff/assign`, {
    ...body,
    preview_token: preview.body.previewToken,
    request_id: crypto.randomUUID(),
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  await drain();
  const op = await call(`/platform/operations/${reply.body.operationId}`);
  expect(op.body.status, JSON.stringify(op.body)).toBe('succeeded');
}
async function publish(id: string) {
  const reply = await call(`/matches/${id}/publish`, {
    request_id: crypto.randomUUID(),
    reason: '发布测试比赛',
  });
  await drain();
  expect((await call(`/platform/operations/${reply.body.operationId}`)).body.status).toBe(
    'succeeded',
  );
}
async function running() {
  const id = await match('正式场A');
  const p1 = await account('玩家一', 'player'),
    p2 = await account('玩家二', 'player'),
    j2 = await account('通讯裁判'),
    j3 = await account('事件裁判');
  for (const p of [p1, p2]) await bind(id, p);
  for (const [login, seat] of [
    [owner, 'J01'],
    [j2, 'J02'],
    [j3, 'J03'],
  ] as const) {
    await invite(id, login);
    await assign(id, login, seat);
  }
  await publish(id);
  return { id, p1, p2, j2, j3 };
}
beforeEach(async () => {
  await reset();
  owner = undefined as unknown as Login;
  const installed = JSON.parse(
    await platform().bootstrap('integration-platform-maintenance-secret', { name: '平台所有者' }),
  );
  owner = await activate(installed.invitation);
});
describe('跨比赛平台与身份边界（可控时钟，无实时赛程等待）', () => {
  it('登录超过10分钟仍可读取邀请、预览和执行管理操作，预览有效期继续检查', async () => {
    const target = await account('待停用工作人员');
    await ageSession(owner, 11 * 3600000);
    expect((await call('/auth/session')).body).not.toHaveProperty('recent');
    const created = await call('/platform/accounts/create', {
      request_id: crypto.randomUUID(),
      name: '待交付邀请',
      kind: 'staff',
      reason: '核对长期登录下的邀请交付',
    });
    const invitation = await call(`/platform/invitations/${created.body.invitationId}`);
    expect(invitation.status, JSON.stringify(invitation.body)).toBe(200);
    expect(invitation.body.invitation).toBe(created.body.invitation);
    const path = '/platform/accounts/status',
      payload = {
        accountId: target.session.account.id,
        status: 'disabled',
        expected_version: target.session.account.version,
        reason: '核对取消近期认证后的管理操作',
      };
    const missing = await call(path, { ...payload, request_id: crypto.randomUUID() });
    expect(missing.body.code).toBe('PREVIEW_REQUIRED');
    const preview = await call('/platform/preview', { path, payload });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    await runInDurableObject(platform(), (_instance, state) =>
      new Store(state.storage).exec(
        'UPDATE platform_previews SET expires=? WHERE id=?',
        Date.now() - 1,
        preview.body.previewToken,
      ),
    );
    const expired = await call(path, {
      ...payload,
      request_id: crypto.randomUUID(),
      preview_token: preview.body.previewToken,
    });
    expect(expired.body.code).toBe('PREVIEW_REQUIRED');
    const fresh = await call('/platform/preview', { path, payload });
    const result = await call(path, {
      ...payload,
      request_id: crypto.randomUUID(),
      preview_token: fresh.body.previewToken,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    await drain();
    expect((await call(`/me/operations/${result.body.operationId}`)).body.status).toBe('succeeded');
    expect((await call('/auth/session', undefined, target)).status).toBe(401);
  });
  it('登录会话超过12小时仍需重新登录', async () => {
    await ageSession(owner, 43200001);
    const result = await call('/platform/preview', {
      path: '/platform/accounts/status',
      payload: {},
    });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('UNAUTHENTICATED');
  });
  it('安装一次、邀请只领取一次，数据库只保存摘要', async () => {
    await runInDurableObject(platform(), async (instance) => {
      await expect(
        instance.bootstrap('integration-platform-maintenance-secret', { name: '第二所有者' }),
      ).rejects.toThrow();
    });
    const created = await call('/platform/accounts/create', {
      request_id: 'create-once',
      name: '待领取玩家',
      kind: 'player',
      reason: '测试单次领取',
    });
    await activate(created.body.invitation, 'player');
    expect((await call('/auth/claim', { invitation: created.body.invitation })).status).toBe(401);
    await runInDurableObject(platform(), (_instance, state) => {
      const db = new Store(state.storage);
      expect(
        db.one('SELECT id FROM invitations WHERE token_hash=?', created.body.invitation),
      ).toBeUndefined();
    });
  });
  it('A/B创建幂等，空草稿和试玩独立，未知ID不会登记新比赛', async () => {
    const id = await match('正式场A', 'official', 'create-A'),
      b = await match('试玩B', 'trial');
    expect(b).not.toBe(id);
    const replay = await call('/platform/matches/create', {
      request_id: 'create-A',
      name: '正式场A',
      kind: 'official',
      retentionConfirmed: true,
      reason: '测试创建独立比赛',
    });
    expect(replay.status).toBe(200);
    expect((await call('/platform/matches')).body).toHaveLength(2);
    const conflict = await call('/platform/matches/create', {
      request_id: 'create-A',
      name: '改名',
      kind: 'official',
      retentionConfirmed: true,
      reason: '测试创建独立比赛',
    });
    expect(conflict.status).toBe(409);
    const current = (await call(`/matches/${id}/manage`)).body.current;
    expect(current.players).toBe(0);
    expect(current.members).toHaveLength(0);
    expect((await call('/matches/unknown/snapshot')).status).toBe(404);
  });
  it('同一长期玩家在两场绑定独立文明；候选不占名单，不获得别场权限', async () => {
    const a = await match('A'),
      b = await match('B'),
      player = await account('同一玩家', 'player');
    await bind(a, player);
    const aInfo = (await call(`/matches/${a}/manage`)).body.current;
    expect(aInfo.players).toBe(0);
    expect(aInfo.members[0].local_id).toBe('C01');
    expect((await call(`/matches/${b}/snapshot`, undefined, player)).status).toBe(403);
    expect((await call('/platform/accounts', undefined, player)).status).toBe(403);
    await bind(b, player);
    expect((await call(`/matches/${b}/manage`)).body.current.members[0].local_id).toBe('C01');
    expect((await call('/me/matches', undefined, player)).body).toHaveLength(2);
  });
  it('发布需要总裁判；已发布玩家请求仍走本场状态，平台管理员不隐式执裁', async () => {
    const empty = await match('无裁判草稿');
    const reply = await call(`/matches/${empty}/publish`, {
      request_id: 'bad-publish',
      reason: '测试发布门槛',
    });
    await drain();
    expect((await call(`/platform/operations/${reply.body.operationId}`)).body.status).toBe(
      'failed',
    );
    const { id, p1 } = await running();
    const snapshot = await call(`/matches/${id}/snapshot?route=/player`, undefined, p1);
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    expect(snapshot.body.session.id).toBe('C01');
    expect(snapshot.body.session.matchId).toBe(id);
    const admin = await account('另一管理员');
    await runInDurableObject(platform(), (_instance, state) => {
      new Store(state.storage).exec(
        "INSERT INTO platform_roles VALUES(?,'admin')",
        admin.session.account.id,
      );
    });
    expect((await call(`/matches/${id}/snapshot?route=/judge`, undefined, admin)).status).toBe(403);
  });
  it('玩家接受邀请即原子绑定文明，重复接受不新增文明；只有总裁判也可发布', async () => {
    const id = await match('单裁判比赛'),
      p1 = await account('接受邀请玩家一', 'player'),
      p2 = await account('接受邀请玩家二', 'player');
    const invitation = await call(`/matches/${id}/members/invite`, {
      request_id: crypto.randomUUID(),
      accountId: p1.session.account.id,
      reason: '邀请参赛',
    });
    expect(invitation.status).toBe(202);
    await drain();
    expect((await call('/me/matches', undefined, p1)).body[0].membership.state).toBe('invited');
    const rejected = await call(
      `/matches/${id}/members/accept`,
      {
        request_id: crypto.randomUUID(),
        consent: false,
        reason: '未确认说明',
      },
      p1,
    );
    await drain();
    expect(
      (await call(`/me/operations/${rejected.body.operationId}`, undefined, p1)).body.status,
    ).toBe('failed');
    expect((await call('/me/matches', undefined, p1)).body[0].membership.state).toBe('invited');
    for (let attempt = 0; attempt < 2; attempt++) {
      const accepted = await call(
        `/matches/${id}/members/accept`,
        {
          request_id: crypto.randomUUID(),
          consent: true,
          reason: '接受邀请',
        },
        p1,
      );
      await drain();
      expect(
        (await call(`/me/operations/${accepted.body.operationId}`, undefined, p1)).body.status,
      ).toBe('succeeded');
    }
    expect((await call('/me/matches', undefined, p1)).body[0]).toMatchObject({
      phase: 'setup',
      membership: { state: 'bound', local_id: 'C01' },
    });
    await bind(id, p2);
    await invite(id, owner);
    await assign(id, owner, 'J01');
    await publish(id);
    const current = (await call(`/matches/${id}/manage`)).body.current;
    expect(
      current.members.filter((member: { kind: string }) => member.kind === 'player'),
    ).toHaveLength(2);
    expect(current.assignments).toHaveLength(1);
    expect((await call(`/matches/${id}/snapshot?route=/player`, undefined, p1)).status).toBe(200);
  });
  it('生产环境所有者与新所有者均可不启用第二因素', async () => {
    const successor = await account('自愿安全设置的新所有者');
    const productionCall = (path: string, body?: unknown) =>
      runInDurableObject(platform(), async (_instance, state) => {
        const service = new DarkForestPlatform(state, { ...bindings, APP_ENV: 'preview' });
        const reply = await service.call({
          path,
          method: body ? 'POST' : 'GET',
          body,
          token: owner.token,
          csrf: owner.session.csrfToken,
          edgeUtc: Date.now(),
          clientKey: 'production-2fa-test',
        });
        return { ...reply, body: JSON.parse(reply.body) };
      });
    expect((await productionCall('/platform/accounts')).status).toBe(200);
    const payload = {
      accountId: successor.session.account.id,
      expected_version: successor.session.account.version,
      role: 'owner',
      enabled: true,
      reason: '交接给未启用第二因素的所有者',
    };
    const preview = await productionCall('/platform/preview', {
      path: '/platform/roles/update',
      payload,
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const result = await productionCall('/platform/roles/update', {
      ...payload,
      request_id: crypto.randomUUID(),
      preview_token: preview.body.previewToken,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  });
  it('总裁判交接原子撤旧启新，原人不能继续使用旧会话', async () => {
    const { id } = await running(),
      next = await account('新总裁判');
    await invite(id, next);
    await ageSession();
    await assign(id, next, 'J01', 1);
    expect((await call(`/matches/${id}/snapshot?route=/judge`, undefined, owner)).status).toBe(403);
    const fresh = await call(`/matches/${id}/snapshot?route=/judge`, undefined, next);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    const current = (await call(`/matches/${id}/manage`)).body.current;
    expect(
      current.assignments.filter(
        (a: { seat_id: string; ended_utc: number | null }) =>
          a.seat_id === 'J01' && a.ended_utc === null,
      ),
    ).toHaveLength(1);
    await ageSession(next);
    const preview = await call(
      `/matches/${id}/preview`,
      {
        path: `/matches/${id}/staff/assign`,
        payload: {
          accountId: owner.session.account.id,
          seat: 'J01',
          expectedVersion: 2,
          reason: '总裁判长期登录后预览交接',
        },
      },
      next,
    );
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  });
  it('全局停用拒绝旧会话，逐场收据完成，不淘汰文明', async () => {
    const { id, p1 } = await running(),
      accountId = p1.session.account.id,
      account = (await call('/platform/accounts')).body.find(
        (a: { id: string }) => a.id === accountId,
      );
    const payload = {
        accountId,
        status: 'disabled',
        expected_version: account.version,
        reason: '本人核验后停用账号',
      },
      preview = await call('/platform/preview', { path: '/platform/accounts/status', payload });
    const result = await call('/platform/accounts/status', {
      ...payload,
      request_id: 'disable-player',
      preview_token: preview.body.previewToken,
    });
    expect(result.status).toBe(202);
    expect((await call(`/matches/${id}/snapshot?route=/player`, undefined, p1)).status).toBe(401);
    await drain();
    expect((await call('/platform/operations/disable-player')).body.status).toBe('succeeded');
    await runInDurableObject(bindings.MATCH_DO.getByName(`match:${id}`), (_instance, state) => {
      expect(new Store(state.storage).flight('C01').status).toBe('prelaunch');
    });
  });
  it('首次冻结后不能绑定新选手；不靠推荐入口修改场次', async () => {
    const a = await match('A'),
      player = await account('晚到玩家', 'player');
    const invitation = await call(`/matches/${a}/members/invite`, {
      request_id: crypto.randomUUID(),
      accountId: player.session.account.id,
      reason: '冻结前邀请',
    });
    expect(invitation.status).toBe(202);
    await drain();
    await runInDurableObject(bindings.MATCH_DO.getByName(`match:${a}`), (_instance, state) => {
      new Store(state.storage).exec(
        "INSERT INTO settings(key,value) VALUES('parameters_frozen','true')",
      );
    });
    const reply = await call(
      `/matches/${a}/members/accept`,
      { request_id: 'late-bind', consent: true, reason: '尝试冻结后接受并绑定' },
      player,
    );
    await drain();
    expect((await call(`/platform/operations/${reply.body.operationId}`)).body.status).toBe(
      'failed',
    );
  });
  it('无需对象存储即可查看战报版本；只有主办方可以下载赛后资料', async () => {
    const { id, p1 } = await running();
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      async (_instance, state) => {
        const db = new Store(state.storage),
          e = new Engine(db, { ...bindings, MATCH_ID: id });
        await e.keys();
        db.exec("INSERT INTO roster_members VALUES('C01')");
        db.exec("INSERT INTO roster_members VALUES('C02')");
        db.exec(
          "INSERT INTO participation_history VALUES(?,'C01',?)",
          p1.session.account.id,
          Date.now(),
        );
        finish(e, 'regulation', 7200000, Date.now(), 'test-end');
        archiveReport(e, '补记判罚说明');
      },
    );
    const history = `/matches/${id}/history`;
    const playerView = await call(history, undefined, p1);
    expect(playerView.status, JSON.stringify(playerView.body)).toBe(200);
    expect(playerView.body.versions.map((row: { version: number }) => row.version)).toEqual([2, 1]);
    expect(playerView.body.replayAvailable).toBe(true);
    expect(playerView.body.downloads).toEqual([]);
    expect((await call(`${history}/replay`, undefined, p1)).status).toBe(200);
    expect((await call(`${history}/download/replay`, undefined, p1)).status).toBe(403);
    await ageSession();
    expect((await call(history)).body.downloads).toEqual(['report', 'audit', 'replay', 'backup']);
    const report = await call(`${history}/download/report?version=1`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.fileName).toContain('第1版');
    const data = JSON.parse(report.body.text);
    expect(data.report.version).toBe(1);
    expect(data.report.standings[0]).not.toHaveProperty('homeworld');
    expect(report.body.text).not.toContain('credential_hash');
    expect((await call(`${history}/download/audit`)).status).toBe(200);
    const backup = await call(`${history}/download/backup`);
    expect(backup.status, JSON.stringify(backup.body)).toBe(200);
    const envelope = JSON.parse(backup.body.text);
    expect(envelope.format).toBe('darkforest-backup-v1');
    expect(typeof envelope.ciphertext).toBe('string');
    expect(envelope).not.toHaveProperty('accounts');
    expect((await call('/platform/data/import', {})).status).toBe(404);
    const candidate = await account('仅候选', 'player');
    await runInDurableObject(platform(), (_instance, state) =>
      new Store(state.storage).exec(
        'INSERT INTO account_match_index VALUES(?,?)',
        candidate.session.account.id,
        id,
      ),
    );
    expect((await call(`${history}/report?version=1`, undefined, candidate)).status).toBe(403);
    expect((await call(`${history}/download/audit`, undefined, candidate)).status).toBe(403);
  });
  it('旧比赛接入保留对象与发行事实，旧口令只能领取一次长期账号', async () => {
    const legacy = bindings.MATCH_DO.getByName('match:integration');
    const accounts = await Promise.all(
      [
        { id: 'C01', role: 'player', name: '同名' },
        { id: 'C02', role: 'player', name: '同名' },
        { id: 'J01', role: 'judge', name: '总裁判', duty: 'head' },
        { id: 'J02', role: 'judge', name: '通讯裁判', duty: 'communications' },
        { id: 'J03', role: 'judge', name: '事件裁判', duty: 'events' },
      ].map(async (a) => ({
        ...a,
        credential_hash: await digest(`legacy-credential-${a.id}-long-enough-for-test`),
      })),
    );
    expect(
      (
        await legacy.bootstrap('integration-only-bootstrap-secret', {
          match_id: 'integration',
          accounts,
        })
      ).status,
    ).toBe(201);
    const args = {
      operationId: 'adopt-existing',
      matchId: 'integration',
      reason: '维护窗口内登记原对象',
    };
    const inventory = JSON.parse(
      await platform().maintenance('integration-platform-maintenance-secret', {
        ...args,
        operation: 'inspect-legacy',
      }),
    );
    const reply = JSON.parse(
      await platform().maintenance('integration-platform-maintenance-secret', {
        ...args,
        operation: 'adopt-legacy',
        name: '既有比赛',
        checkpointDigest: await digest(stableJson(inventory.checkpoint)),
        confirm: '接入旧比赛 integration',
      }),
    );
    expect(reply.receipt.accounts).toBe(5);
    const one = await activate('legacy-credential-C01-long-enough-for-test', 'player'),
      two = await activate('legacy-credential-C02-long-enough-for-test', 'player');
    expect(one.session.account.id).not.toBe(two.session.account.id);
    const snapshot = await call('/matches/integration/snapshot?route=/player', undefined, one);
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    expect(snapshot.body.session.id).toBe('C01');
    expect(
      (await call('/auth/claim', { invitation: 'legacy-credential-C01-long-enough-for-test' }))
        .status,
    ).toBe(401);
  });
  it('申诉保留与7天清理等待生效，清理后保留战报并禁止读取完整复盘或启动旧恢复', async () => {
    const { id, p1 } = await running();
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      async (_instance, state) => {
        const db = new Store(state.storage),
          e = new Engine(db, { ...bindings, MATCH_ID: id });
        await e.keys();
        db.exec("INSERT INTO roster_members VALUES('C01')");
        db.exec("INSERT INTO roster_members VALUES('C02')");
        db.exec(
          "INSERT INTO participation_history VALUES(?,'C01',?)",
          p1.session.account.id,
          Date.now(),
        );
        finish(e, 'regulation', 7200000, Date.now(), 'purge-test');
      },
    );
    const mutation = async (path: string, extra: Record<string, unknown>) => {
      const d = (await call('/platform/matches')).body.find((m: { id: string }) => m.id === id),
        payload = { matchId: id, expected_version: d.version, reason: '清理边界核对', ...extra };
      const preview = await call('/platform/preview', { path, payload });
      return call(path, {
        ...payload,
        request_id: crypto.randomUUID(),
        preview_token: preview.body.previewToken,
      });
    };
    const history = `/matches/${id}/history`;
    expect((await call(`${history}/download/replay`)).status).toBe(200);
    const reportBeforeCleanup = (await call(`${history}/report?version=1`, undefined, p1)).body
      .report;
    expect((await mutation('/platform/data/purge', {})).status).toBe(409);
    await runInDurableObject(bindings.MATCH_DO.getByName(`match:${id}`), (_instance, state) =>
      new Store(state.storage).exec('UPDATE matches SET ended_utc=?', Date.now() - 50 * 86400000),
    );
    expect(
      (await mutation('/platform/data/hold', { reviewUtc: Date.now() + 86400000 })).status,
    ).toBe(200);
    expect((await mutation('/platform/data/purge', {})).status).toBe(409);
    expect((await mutation('/platform/data/hold', { release: true })).status).toBe(200);
    const purge = await mutation('/platform/data/purge', {});
    expect(purge.status).toBe(202);
    await drain();
    expect((await call(`/platform/operations/${purge.body.operationId}`)).body.status).toBe(
      'pending',
    );
    // Advance only the persistent queue's due marker; no wall-clock wait or real-time schedule runs.
    await runInDurableObject(platform(), (_instance, state) =>
      new Store(state.storage).exec(
        'UPDATE platform_operations SET next_attempt=0 WHERE id=?',
        purge.body.operationId,
      ),
    );
    await drain();
    const completed = await call(`/platform/operations/${purge.body.operationId}`);
    expect(completed.body.status, JSON.stringify(completed.body)).toBe('succeeded');
    expect((await call(`/matches/${id}/snapshot?route=/results`, undefined, p1)).status).toBe(410);
    expect((await call(`${history}/replay`, undefined, p1)).status).toBe(410);
    expect((await call(`${history}/download/backup`)).status).toBe(410);
    expect((await call(`${history}/report?version=1`, undefined, p1)).status).toBe(200);
    expect((await call(`${history}/report?version=1`, undefined, p1)).body.report).toEqual(
      reportBeforeCleanup,
    );
    expect((await call(`${history}/download/audit`)).status).toBe(200);
    // Simulate the match database losing its cleanup marker after a rollback. The
    // platform database still denies a launch and any sensitive download.
    await runInDurableObject(bindings.MATCH_DO.getByName(`match:${id}`), (_instance, state) => {
      const db = new Store(state.storage);
      db.exec('UPDATE match_identity SET erasure_generation=0');
      db.exec('UPDATE matches SET ended_utc=?', Date.now());
    });
    expect((await call(`${history}/download/replay`)).status).toBe(410);
    await runInDurableObject(platform(), async (instance) => {
      await expect(
        instance.maintenance('integration-platform-maintenance-secret', {
          operation: 'recovery',
          operationId: 'launch-after-cleanup',
          matchId: id,
          reason: '验证清理记录拦住旧检查点',
          payload: { operation: 'launch', payload: {} },
        }),
      ).rejects.toThrow('本场完整信息已清理');
    });
  });
  it('恢复启动前必须有本地材料回读收据，凭据撤销不随本场检查点回退', async () => {
    const { id, p1 } = await running();
    const target = await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      async (_instance, state) => {
        const e = new Engine(new Store(state.storage), { ...bindings, MATCH_ID: id });
        return createCheckpoint(e);
      },
    );
    const base = { operationId: 'recovery-gate', matchId: id, reason: '受控恢复流程检查' },
      carry = JSON.parse(
        await platform().maintenance('integration-platform-maintenance-secret', {
          ...base,
          operation: 'recovery',
          payload: { operation: 'prepare', payload: { target, reason: base.reason } },
        }),
      );
    await runInDurableObject(platform(), async (instance) => {
      await expect(
        instance.maintenance('integration-platform-maintenance-secret', {
          ...base,
          operation: 'recovery',
          confirm: `恢复比赛 ${id}`,
          payload: { operation: 'launch', payload: carry },
        }),
      ).rejects.toThrow('必须保存');
    });
    const saved = JSON.parse(
      await platform().maintenance('integration-platform-maintenance-secret', {
        ...base,
        operation: 'carry-receipt',
        carry,
        sha256: await digest(stableJson(carry)),
      }),
    );
    expect(saved.saved).toBe(true);
    const accountId = p1.session.account.id,
      account = (await call('/platform/accounts')).body.find(
        (a: { id: string }) => a.id === accountId,
      );
    const payload = {
        accountId,
        status: 'disabled',
        expected_version: account.version,
        reason: '保全材料生成后停用账号',
      },
      preview = await call('/platform/preview', { path: '/platform/accounts/status', payload });
    expect(
      (
        await call('/platform/accounts/status', {
          ...payload,
          request_id: 'fence-during-recovery',
          preview_token: preview.body.previewToken,
        })
      ).status,
    ).toBe(202);
    await drain();
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      async (_instance, state) => {
        const e = new Engine(new Store(state.storage), { ...bindings, MATCH_ID: id });
        restoreCheckpointTables(e, (await openCheckpoint(e, target)).tables);
      },
    );
    const recovered = JSON.parse(
      await platform().maintenance('integration-platform-maintenance-secret', {
        ...base,
        operation: 'recovery',
        payload: { operation: 'complete', payload: carry },
      }),
    );
    expect(recovered.id).toBe(carry.id);
    expect((await call(`/matches/${id}/snapshot?route=/player`, undefined, p1)).status).toBe(401);
    await runInDurableObject(bindings.MATCH_DO.getByName(`match:${id}`), (_instance, state) => {
      const db = new Store(state.storage);
      expect(
        db.one('SELECT disabled FROM authorization_fences WHERE account_id=?', accountId),
      ).toEqual({ disabled: 1 });
      expect(db.match().recovery_state).toMatch(/^review:/);
    });
  });
  it('网关隔离玩家与工作人员Cookie，拒绝跨站写入与无场次旧写接口', async () => {
    const gatewayEnv = {
      APP_ENV: 'local',
      MATCH_ID: 'integration',
      TRUSTED_ORIGINS: 'https://game.test',
      MATCH_DO: bindings.MATCH_DO,
      PLATFORM_DO: bindings.PLATFORM_DO!,
    };
    const response = await gateway(
      new Request('https://game.test/api/auth/exchange', {
        method: 'POST',
        headers: { Origin: 'https://game.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: owner.credential, audience: 'staff' }),
      }),
      gatewayEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('df_staff_local=');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const rejected = await gateway(
      new Request('https://game.test/api/platform/matches/create', {
        method: 'POST',
        headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      gatewayEnv,
    );
    expect(rejected.status).toBe(403);
    expect(
      (
        await gateway(
          new Request('https://game.test/api/action/sighting', {
            method: 'POST',
            headers: { Origin: 'https://game.test', 'Content-Type': 'application/json' },
            body: '{}',
          }),
          gatewayEnv,
        )
      ).status,
    ).toBe(409);
  });
  it('档案管理员只发现获授权比赛，无法预览他场清理或全局账号操作', async () => {
    const a = await match('授权场'),
      b = await match('未授权场'),
      archivist = await account('档案工作人员');
    const payload = {
        accountId: archivist.session.account.id,
        role: 'archivist',
        matchId: a,
        enabled: true,
        expected_version: archivist.session.account.version,
        reason: '授予单场档案管理权限',
      },
      preview = await call('/platform/preview', { path: '/platform/roles/update', payload });
    const grant = await call('/platform/roles/update', {
      ...payload,
      request_id: 'scoped-archive-role',
      preview_token: preview.body.previewToken,
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    expect(
      (await call('/platform/matches', undefined, archivist)).body.map((m: { id: string }) => m.id),
    ).toEqual([a]);
    expect(
      (
        await call(
          '/platform/preview',
          { path: '/platform/data/purge', payload: { matchId: b } },
          archivist,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          '/platform/preview',
          { path: '/platform/accounts/status', payload: { accountId: owner.session.account.id } },
          archivist,
        )
      ).status,
    ).toBe(403);
  });
  it('第二因素验证码及恢复码不可重复使用', async () => {
    const setup = await call('/me/security/setup', {});
    expect(setup.status).toBe(200);
    const code = await totp(setup.body.secret, Math.floor(Date.now() / 30000)),
      confirmed = await call('/me/security/confirm', { code });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(
      (await call('/auth/exchange', { credential: owner.credential, audience: 'staff', code }))
        .status,
    ).toBe(401);
    const recovery = confirmed.body.recoveryCodes[0];
    expect(
      (
        await call('/auth/exchange', {
          credential: owner.credential,
          audience: 'staff',
          code: recovery,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('/auth/exchange', {
          credential: owner.credential,
          audience: 'staff',
          code: recovery,
        })
      ).status,
    ).toBe(401);
  });
  it('自愿启用第二因素后可以关闭，关闭后长期口令可以独立登录', async () => {
    await ageSession();
    const setup = await call('/me/security/setup', {});
    const code = await totp(setup.body.secret, Math.floor(Date.now() / 30000));
    expect((await call('/me/security/confirm', { code })).status).toBe(200);
    expect((await call('/auth/session')).body.secondFactorEnabled).toBe(true);
    expect((await call('/me/security/disable', {})).status).toBe(200);
    expect((await call('/auth/session')).body.secondFactorEnabled).toBe(false);
    expect(
      (await call('/auth/exchange', { credential: owner.credential, audience: 'staff' })).status,
    ).toBe(200);
    expect(
      await runInDurableObject(platform(), (_instance, state) =>
        new Store(state.storage).all('SELECT * FROM recovery_codes'),
      ),
    ).toEqual([]);
  });
  it('会话未验证第二因素时仍不能关闭，验证成功后不设置近期认证时限', async () => {
    const login = owner;
    const setup = await call('/me/security/setup', {});
    const code = await totp(setup.body.secret, Math.floor(Date.now() / 30000));
    const confirmed = await call('/me/security/confirm', { code });
    expect(confirmed.status).toBe(200);
    const hash = await digest(login.token);
    await runInDurableObject(platform(), (_instance, state) =>
      new Store(state.storage).exec(
        'UPDATE platform_sessions SET second_factor=0 WHERE token_hash=?',
        hash,
      ),
    );
    await ageSession(login);
    const denied = await call('/me/security/disable', {}, login);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('SECOND_FACTOR_REQUIRED');
    expect(
      (await call('/auth/reauth', { credential: owner.credential, code: 'invalid' }, login)).status,
    ).toBe(401);
    const verified = await call(
      '/auth/reauth',
      { credential: owner.credential, code: confirmed.body.recoveryCodes[0] },
      login,
    );
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(verified.body.secondFactor).toBe(true);
    await ageSession(login, 11 * 3600000);
    expect((await call('/me/security/disable', {}, login)).status).toBe(200);
  });
});
