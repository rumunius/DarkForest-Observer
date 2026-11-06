import {
  parseJson,
  jsonObject,
  jsonArray,
  jsonObjects,
  jsonString,
  platformSession,
} from '../helpers/json';
import {beforeEach, describe, expect, it} from 'vitest';
import {env} from 'cloudflare:workers';
import {reset, runInDurableObject} from 'cloudflare:test';
import type {BackendEnv, RpcInput} from '../../apps/match-worker/src/rpc/types';
import type {PlatformSession} from '@darkforest/contracts';
import {Store} from '../../apps/match-worker/src/storage/store';
import {Engine} from '../../apps/match-worker/src/services/engine';
import {archiveReport, finish} from '../../apps/match-worker/src/services/life';
import {gateway} from '../../apps/web/functions/_lib/gateway';
import {digest} from '../../apps/match-worker/src/security/crypto';
import {stableJson} from '../../packages/contracts/src/backend';
import {totp} from '../../apps/match-worker/src/platform/security';
import {DarkForestPlatform} from '../../apps/match-worker/src/platform/platform';
import {
  createCheckpoint,
  openCheckpoint,
  restoreCheckpointTables,
} from '../../apps/match-worker/src/services/recovery';

const bindings: BackendEnv = env;
const platform = () => bindings.PLATFORM_DO!.getByName('platform:primary');
interface Login {
  token: string;
  session: PlatformSession;
  credential: string;
}
let owner: Login;
async function ageSession(login = owner, age = 3600000) {
  const hash = await digest(login.token);
  const created = Date.now() - age;
  await runInDurableObject(platform(), (_instance, state) =>
    new Store(state.storage).exec(
      'UPDATE platform_sessions SET created_utc=?,expires=?,reauth_utc=0 WHERE token_hash=?',
      created,
      created + 43200000,
      hash,
    ),
  );
}
async function call(path: string, body?: unknown, login: Login | null = owner) {
  const input: RpcInput = {
    method: body === undefined ? 'GET' : 'POST',
    path,
    edgeUtc: Date.now(),
    clientKey: 'platform-test',
    ...(body === undefined ? {} : {body}),
    ...(login ? {token: login.token, csrf: login.session.csrfToken} : {}),
  };
  const reply = await platform().call(input);
  return {...reply, body: parseJson(reply.body)};
}
async function activate(invitation: string, kind = 'staff'): Promise<Login> {
  // Credential exchange is anonymous, including before the first owner exists.
  const claim = await call('/auth/claim', {invitation}, null);
  expect(claim.status, JSON.stringify(claim.body)).toBe(200);
  const credential = jsonString(jsonObject(claim.body).credential);
  const login = await call(
    '/auth/exchange',
    {credential, audience: kind},
    null,
  );
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return {
    token: login.sessionToken!,
    session: platformSession(login.body),
    credential,
  };
}
async function account(name: string, kind = 'staff') {
  const create = await call('/platform/accounts/create', {
    request_id: crypto.randomUUID(),
    name,
    kind,
    reason: '测试创建长期账号',
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  return activate(jsonString(jsonObject(create.body).invitation), kind);
}
async function drain() {
  await runInDurableObject(platform(), instance => instance.alarm());
}
async function match(
  name: string,
  kind = 'official',
  suppliedRequestId?: string,
) {
  const requestId =
    suppliedRequestId === undefined ? crypto.randomUUID() : suppliedRequestId;
  const reply = await call('/platform/matches/create', {
    request_id: requestId,
    name,
    kind,
    retentionConfirmed: true,
    reason: '测试创建独立比赛',
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  await drain();
  const op = await call(`/platform/operations/${requestId}`);
  expect(jsonObject(op.body).status, JSON.stringify(op.body)).toBe('succeeded');
  return jsonString(jsonObject(reply.body).matchId);
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
    {
      request_id: crypto.randomUUID(),
      consent: true,
      reason: '本人接受比赛与数据期限',
    },
    login,
  );
  expect(accept.status, JSON.stringify(accept.body)).toBe(202);
  await drain();
}
async function bind(id: string, login: Login) {
  await invite(id, login);
}
async function assign(
  id: string,
  login: Login,
  seat: string,
  expectedVersion = 0,
) {
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
    preview_token: jsonObject(preview.body).previewToken,
    request_id: crypto.randomUUID(),
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  await drain();
  const op = await call(
    `/platform/operations/${jsonString(jsonObject(reply.body).operationId)}`,
  );
  expect(jsonObject(op.body).status, JSON.stringify(op.body)).toBe('succeeded');
}
async function publish(id: string) {
  const reply = await call(`/matches/${id}/publish`, {
    request_id: crypto.randomUUID(),
    reason: '发布测试比赛',
  });
  await drain();
  expect(
    jsonObject(
      (
        await call(
          `/platform/operations/${jsonString(jsonObject(reply.body).operationId)}`,
        )
      ).body,
    ).status,
  ).toBe('succeeded');
}
async function removeMember(
  id: string,
  target: Login,
  actor = owner,
  suppliedRequestId?: string,
) {
  const requestId =
    suppliedRequestId === undefined ? crypto.randomUUID() : suppliedRequestId;
  const current = jsonObject(
    jsonObject((await call(`/matches/${id}/manage`, undefined, actor)).body)
      .current,
  );
  const body = {
    request_id: requestId,
    accountId: target.session.account.id,
    expectedRevision: current.revision,
    reason: '发布前移除成员并回收编号',
  };
  const reply = await call(`/matches/${id}/members/remove`, body, actor);
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  await drain();
  const op = await call(`/me/operations/${requestId}`, undefined, actor);
  return {op: op.body, body};
}
async function running() {
  const id = await match('正式场A');
  const p1 = await account('玩家一', 'player');
  const p2 = await account('玩家二', 'player');
  const j2 = await account('通讯裁判');
  const j3 = await account('事件裁判');
  for (const p of [p1, p2]) {
    await bind(id, p);
  }
  for (const [login, seat] of [
    [owner, 'J01'],
    [j2, 'J02'],
    [j3, 'J03'],
  ] as const) {
    await invite(id, login);
    await assign(id, login, seat);
  }
  await publish(id);
  return {id, p1, p2, j2, j3};
}
beforeEach(async () => {
  await reset();
  const installed = jsonObject(
    parseJson(
      await platform().bootstrap('integration-platform-maintenance-secret', {
        name: '平台所有者',
      }),
    ),
  );
  owner = await activate(jsonString(installed.invitation));
});
describe('跨比赛平台与身份边界（可控时钟，无实时赛程等待）', () => {
  it('草稿可移除未接受、已接受及已绑定成员，释放中间编号且不串用身份数据', async () => {
    const id = await match('移除成员草稿');
    const pending = await account('尚未接受', 'player');
    const accepted = await account('已接受工作人员');
    const first = await account('首位玩家', 'player');
    const middle = await account('中间玩家', 'player');
    const last = await account('末位玩家', 'player');
    await call(`/matches/${id}/members/invite`, {
      request_id: crypto.randomUUID(),
      accountId: pending.session.account.id,
      reason: '邀请待接受账号',
    });
    await drain();
    await invite(id, accepted);
    for (const player of [first, middle, last]) {
      await bind(id, player);
    }
    const other = await match('同账号另一场');
    await bind(other, middle);
    for (const target of [pending, accepted]) {
      expect(jsonObject((await removeMember(id, target)).op).status).toBe(
        'succeeded',
      );
      expect((await call('/me/matches', undefined, target)).body).toEqual([]);
      const accept = await call(
        `/matches/${id}/members/accept`,
        {
          request_id: crypto.randomUUID(),
          consent: true,
          reason: '尝试接受已撤销邀请',
        },
        target,
      );
      await drain();
      expect(
        jsonObject(
          (
            await call(
              `/me/operations/${jsonString(jsonObject(accept.body).operationId)}`,
              undefined,
              target,
            )
          ).body,
        ).status,
      ).toBe('failed');
    }
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      (_instance, state) => {
        const db = new Store(state.storage);
        db.exec(
          "UPDATE players SET nickname='旧昵称',tech=1,photons=1,broadcasts=2 WHERE id='C02'",
        );
        db.exec("INSERT INTO roster_members VALUES('C02')");
        db.exec(
          "INSERT INTO homeworlds(player_id,code,status,version) VALUES('C02','123456','pending',1)",
        );
      },
    );
    const removed = await removeMember(id, middle);
    expect(jsonObject(removed.op).status, JSON.stringify(removed.op)).toBe(
      'succeeded',
    );
    // Identical retries return the original receipt, including after the slot is reused.
    const next = await account('新玩家', 'player');
    await bind(id, next);
    await drain();
    const retry = await call(`/matches/${id}/members/remove`, removed.body);
    expect(jsonObject(retry.body).status).toBe('succeeded');
    const current = jsonObject(
      jsonObject((await call(`/matches/${id}/manage`)).body).current,
    );
    expect(
      jsonObjects(current.members)
        .map(m => m.local_id)
        .sort(),
    ).toEqual(['C01', 'C02', 'C03']);
    expect(
      jsonObject(
        jsonObjects(current.members).find(
          m => m.account_id === next.session.account.id,
        ),
      ).local_id,
    ).toBe('C02');
    expect(
      jsonObjects((await call('/me/matches', undefined, middle)).body).map(
        m => m.id,
      ),
    ).toEqual([other]);
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      (_instance, state) => {
        const db = new Store(state.storage);
        expect(db.player('C02')).toMatchObject({
          nickname: null,
          tech: 0,
          photons: 0,
          broadcasts: 0,
        });
        expect(db.home('C02')).toBeUndefined();
        expect(db.roster()).toEqual([]);
        expect(db.flight('C02')).toMatchObject({
          status: 'prelaunch',
          voyage: 0,
        });
      },
    );
    await bind(id, middle);
    expect(
      jsonObject(
        jsonObject(
          jsonObjects((await call('/me/matches', undefined, middle)).body).find(
            m => m.id === id,
          ),
        ).membership,
      ).local_id,
    ).toBe('C04');
    await invite(id, owner);
    await assign(id, owner, 'J01');
    await publish(id);
    expect(
      (await call(`/matches/${id}/snapshot?route=/player`, undefined, middle))
        .status,
    ).toBe(200);
    expect(
      (await call(`/matches/${id}/snapshot?route=/player`, undefined, next))
        .status,
    ).toBe(200);
  });
  it('已任职裁判可在发布前移除，岗位结束且同岗位能够重新任命', async () => {
    const id = await match('移除裁判草稿');
    const judge = await account('待移除裁判');
    await invite(id, judge);
    await assign(id, judge, 'J01');
    expect(jsonObject((await removeMember(id, judge)).op).status).toBe(
      'succeeded',
    );
    const current = jsonObject(
      jsonObject((await call(`/matches/${id}/manage`)).body).current,
    );
    expect(current.members).toHaveLength(0);
    expect(jsonObject(jsonArray(current.assignments)[0]).ended_utc).toBeTypeOf(
      'number',
    );
    await invite(id, owner);
    await assign(id, owner, 'J01', 2);
    expect(
      jsonObject(
        jsonArray(
          jsonObject(
            jsonObject((await call(`/matches/${id}/manage`)).body).current,
          ).members,
        )[0],
      ).local_id,
    ).toBe('J01');
  });
  it('总裁判可移除成员，普通玩家不能移除；已发布、冻结和过时版本均拒绝移除', async () => {
    const {id, p1, p2, j2} = await running();
    const forbidden = await call(
      `/matches/${id}/members/remove`,
      {
        request_id: crypto.randomUUID(),
        accountId: p2.session.account.id,
        expectedRevision: 0,
        reason: '越权移除',
      },
      p1,
    );
    expect(forbidden.status).toBe(403);
    expect(
      (
        await call(
          `/matches/${id}/members/remove`,
          {
            request_id: crypto.randomUUID(),
            accountId: p2.session.account.id,
            expectedRevision: 0,
            reason: '普通裁判越权移除',
          },
          j2,
        )
      ).status,
    ).toBe(403);
    expect(jsonObject((await removeMember(id, p1)).op).status).toBe('failed');
    const draft = await match('总裁判管理草稿');
    const head = await account('本场总裁判');
    await invite(draft, head);
    await assign(draft, head, 'J01');
    await bind(draft, p1);
    const stale = jsonObject(
      jsonObject((await call(`/matches/${draft}/manage`)).body).current,
    ).revision;
    await bind(draft, p2);
    const conflict = await call(`/matches/${draft}/members/remove`, {
      request_id: crypto.randomUUID(),
      accountId: p1.session.account.id,
      expectedRevision: stale,
      reason: '过时页面移除',
    });
    await drain();
    expect(
      jsonObject(
        (
          await call(
            `/me/operations/${jsonString(jsonObject(conflict.body).operationId)}`,
          )
        ).body,
      ).status,
    ).toBe('failed');
    expect(jsonObject((await removeMember(draft, p1, head)).op).status).toBe(
      'succeeded',
    );
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${draft}`),
      (_instance, state) =>
        new Store(state.storage).exec(
          "INSERT INTO settings(key,value) VALUES('parameters_frozen','1')",
        ),
    );
    expect(jsonObject((await removeMember(draft, p2, head)).op).status).toBe(
      'failed',
    );
    expect(
      jsonObjects(
        jsonObject(
          jsonObject((await call(`/matches/${draft}/manage`)).body).current,
        ).members,
      ).some(m => m.account_id === p2.session.account.id),
    ).toBe(true);
  });
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
    const invitation = await call(
      `/platform/invitations/${jsonString(jsonObject(created.body).invitationId)}`,
    );
    expect(invitation.status, JSON.stringify(invitation.body)).toBe(200);
    expect(jsonObject(invitation.body).invitation).toBe(
      jsonObject(created.body).invitation,
    );
    const path = '/platform/accounts/status';
    const payload = {
      accountId: target.session.account.id,
      status: 'disabled',
      expected_version: target.session.account.version,
      reason: '核对取消近期认证后的管理操作',
    };
    const missing = await call(path, {
      ...payload,
      request_id: crypto.randomUUID(),
    });
    expect(jsonObject(missing.body).code).toBe('PREVIEW_REQUIRED');
    const preview = await call('/platform/preview', {path, payload});
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    await runInDurableObject(platform(), (_instance, state) =>
      new Store(state.storage).exec(
        'UPDATE platform_previews SET expires=? WHERE id=?',
        Date.now() - 1,
        jsonString(jsonObject(preview.body).previewToken),
      ),
    );
    const expired = await call(path, {
      ...payload,
      request_id: crypto.randomUUID(),
      preview_token: jsonObject(preview.body).previewToken,
    });
    expect(jsonObject(expired.body).code).toBe('PREVIEW_REQUIRED');
    const fresh = await call('/platform/preview', {path, payload});
    const result = await call(path, {
      ...payload,
      request_id: crypto.randomUUID(),
      preview_token: jsonObject(fresh.body).previewToken,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    await drain();
    expect(
      jsonObject(
        (
          await call(
            `/me/operations/${jsonString(jsonObject(result.body).operationId)}`,
          )
        ).body,
      ).status,
    ).toBe('succeeded');
    expect((await call('/auth/session', undefined, target)).status).toBe(401);
  });
  it('登录会话超过12小时仍需重新登录', async () => {
    await ageSession(owner, 43200001);
    const result = await call('/platform/preview', {
      path: '/platform/accounts/status',
      payload: {},
    });
    expect(result.status).toBe(401);
    expect(jsonObject(result.body).code).toBe('UNAUTHENTICATED');
  });
  it('安装一次、邀请只领取一次，数据库只保存摘要', async () => {
    await runInDurableObject(platform(), async instance => {
      await expect(
        instance.bootstrap('integration-platform-maintenance-secret', {
          name: '第二所有者',
        }),
      ).rejects.toThrow();
    });
    const created = await call('/platform/accounts/create', {
      request_id: 'create-once',
      name: '待领取玩家',
      kind: 'player',
      reason: '测试单次领取',
    });
    await activate(jsonString(jsonObject(created.body).invitation), 'player');
    expect(
      (
        await call('/auth/claim', {
          invitation: jsonObject(created.body).invitation,
        })
      ).status,
    ).toBe(401);
    await runInDurableObject(platform(), (_instance, state) => {
      const db = new Store(state.storage);
      expect(
        db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM invitations WHERE token_hash=?',
          jsonString(jsonObject(created.body).invitation),
        ),
      ).toBeUndefined();
    });
  });
  it('A/B创建幂等，空草稿和试玩独立，未知ID不会登记新比赛', async () => {
    const id = await match('正式场A', 'official', 'create-A');
    const b = await match('试玩B', 'trial');
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
    const current = jsonObject(
      jsonObject((await call(`/matches/${id}/manage`)).body).current,
    );
    expect(current.players).toBe(0);
    expect(current.members).toHaveLength(0);
    expect((await call('/matches/unknown/snapshot')).status).toBe(404);
  });
  it('同一长期玩家在两场绑定独立文明；候选不占名单，不获得别场权限', async () => {
    const a = await match('A');
    const b = await match('B');
    const player = await account('同一玩家', 'player');
    await bind(a, player);
    const aInfo = jsonObject(
      jsonObject((await call(`/matches/${a}/manage`)).body).current,
    );
    expect(aInfo.players).toBe(0);
    expect(jsonObject(jsonArray(aInfo.members)[0]).local_id).toBe('C01');
    expect(
      (await call(`/matches/${b}/snapshot`, undefined, player)).status,
    ).toBe(403);
    expect((await call('/platform/accounts', undefined, player)).status).toBe(
      403,
    );
    await bind(b, player);
    expect(
      jsonObject(
        jsonArray(
          jsonObject(
            jsonObject((await call(`/matches/${b}/manage`)).body).current,
          ).members,
        )[0],
      ).local_id,
    ).toBe('C01');
    expect((await call('/me/matches', undefined, player)).body).toHaveLength(2);
  });
  it('发布需要总裁判；已发布玩家请求仍走本场状态，平台管理员不隐式执裁', async () => {
    const empty = await match('无裁判草稿');
    const reply = await call(`/matches/${empty}/publish`, {
      request_id: 'bad-publish',
      reason: '测试发布门槛',
    });
    await drain();
    expect(
      jsonObject(
        (
          await call(
            `/platform/operations/${jsonString(jsonObject(reply.body).operationId)}`,
          )
        ).body,
      ).status,
    ).toBe('failed');
    const {id, p1} = await running();
    const snapshot = await call(
      `/matches/${id}/snapshot?route=/player`,
      undefined,
      p1,
    );
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    expect(jsonObject(jsonObject(snapshot.body).session).id).toBe('C01');
    expect(jsonObject(jsonObject(snapshot.body).session).matchId).toBe(id);
    const admin = await account('另一管理员');
    await runInDurableObject(platform(), (_instance, state) => {
      new Store(state.storage).exec(
        "INSERT INTO platform_roles VALUES(?,'admin')",
        admin.session.account.id,
      );
    });
    expect(
      (await call(`/matches/${id}/snapshot?route=/judge`, undefined, admin))
        .status,
    ).toBe(403);
  });
  it('玩家接受邀请即原子绑定文明，重复接受不新增文明；只有总裁判也可发布', async () => {
    const id = await match('单裁判比赛');
    const p1 = await account('接受邀请玩家一', 'player');
    const p2 = await account('接受邀请玩家二', 'player');
    const invitation = await call(`/matches/${id}/members/invite`, {
      request_id: crypto.randomUUID(),
      accountId: p1.session.account.id,
      reason: '邀请参赛',
    });
    expect(invitation.status).toBe(202);
    await drain();
    expect(
      jsonObject(
        jsonObject(
          jsonArray((await call('/me/matches', undefined, p1)).body)[0],
        ).membership,
      ).state,
    ).toBe('invited');
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
      jsonObject(
        (
          await call(
            `/me/operations/${jsonString(jsonObject(rejected.body).operationId)}`,
            undefined,
            p1,
          )
        ).body,
      ).status,
    ).toBe('failed');
    expect(
      jsonObject(
        jsonObject(
          jsonArray((await call('/me/matches', undefined, p1)).body)[0],
        ).membership,
      ).state,
    ).toBe('invited');
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
        jsonObject(
          (
            await call(
              `/me/operations/${jsonString(jsonObject(accepted.body).operationId)}`,
              undefined,
              p1,
            )
          ).body,
        ).status,
      ).toBe('succeeded');
    }
    expect(
      jsonArray((await call('/me/matches', undefined, p1)).body)[0],
    ).toMatchObject({
      phase: 'setup',
      membership: {state: 'bound', local_id: 'C01'},
    });
    await bind(id, p2);
    await invite(id, owner);
    await assign(id, owner, 'J01');
    await publish(id);
    const current = jsonObject(
      jsonObject((await call(`/matches/${id}/manage`)).body).current,
    );
    expect(
      jsonObjects(current.members).filter(member => member.kind === 'player'),
    ).toHaveLength(2);
    expect(current.assignments).toHaveLength(1);
    expect(
      (await call(`/matches/${id}/snapshot?route=/player`, undefined, p1))
        .status,
    ).toBe(200);
  });
  it('生产环境所有者与新所有者均可不启用第二因素', async () => {
    const successor = await account('自愿安全设置的新所有者');
    const productionCall = (path: string, body?: unknown) =>
      runInDurableObject(platform(), async (_instance, state) => {
        const service = new DarkForestPlatform(state, {
          ...bindings,
          APP_ENV: 'preview',
        });
        const reply = await service.call({
          path,
          method: body ? 'POST' : 'GET',
          body,
          token: owner.token,
          csrf: owner.session.csrfToken,
          edgeUtc: Date.now(),
          clientKey: 'production-2fa-test',
        });
        return {...reply, body: parseJson(reply.body)};
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
      preview_token: jsonObject(preview.body).previewToken,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  });
  it('总裁判交接原子撤旧启新，原人不能继续使用旧会话', async () => {
    const {id} = await running();
    const next = await account('新总裁判');
    await invite(id, next);
    await ageSession();
    await assign(id, next, 'J01', 1);
    expect(
      (await call(`/matches/${id}/snapshot?route=/judge`, undefined, owner))
        .status,
    ).toBe(403);
    const fresh = await call(
      `/matches/${id}/snapshot?route=/judge`,
      undefined,
      next,
    );
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    const current = jsonObject(
      jsonObject((await call(`/matches/${id}/manage`)).body).current,
    );
    expect(
      jsonObjects(current.assignments).filter(
        a => a.seat_id === 'J01' && a.ended_utc === null,
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
    const {id, p1} = await running();
    const accountId = p1.session.account.id;
    const account = jsonObjects((await call('/platform/accounts')).body).find(
      a => a.id === accountId,
    );
    const payload = {
      accountId,
      status: 'disabled',
      expected_version: jsonObject(account).version,
      reason: '本人核验后停用账号',
    };
    const preview = await call('/platform/preview', {
      path: '/platform/accounts/status',
      payload,
    });
    const result = await call('/platform/accounts/status', {
      ...payload,
      request_id: 'disable-player',
      preview_token: jsonObject(preview.body).previewToken,
    });
    expect(result.status).toBe(202);
    expect(
      (await call(`/matches/${id}/snapshot?route=/player`, undefined, p1))
        .status,
    ).toBe(401);
    await drain();
    expect(
      jsonObject((await call('/platform/operations/disable-player')).body)
        .status,
    ).toBe('succeeded');
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      (_instance, state) => {
        expect(new Store(state.storage).flight('C01').status).toBe('prelaunch');
      },
    );
  });
  it('首次冻结后不能绑定新选手；不靠推荐入口修改场次', async () => {
    const a = await match('A');
    const player = await account('晚到玩家', 'player');
    const invitation = await call(`/matches/${a}/members/invite`, {
      request_id: crypto.randomUUID(),
      accountId: player.session.account.id,
      reason: '冻结前邀请',
    });
    expect(invitation.status).toBe(202);
    await drain();
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${a}`),
      (_instance, state) => {
        new Store(state.storage).exec(
          "INSERT INTO settings(key,value) VALUES('parameters_frozen','true')",
        );
      },
    );
    const reply = await call(
      `/matches/${a}/members/accept`,
      {request_id: 'late-bind', consent: true, reason: '尝试冻结后接受并绑定'},
      player,
    );
    await drain();
    expect(
      jsonObject(
        (
          await call(
            `/platform/operations/${jsonString(jsonObject(reply.body).operationId)}`,
          )
        ).body,
      ).status,
    ).toBe('failed');
  });
  it('无需对象存储即可查看战报版本；只有主办方可以下载赛后资料', async () => {
    const {id, p1} = await running();
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      async (_instance, state) => {
        const db = new Store(state.storage);
        const e = new Engine(db, {...bindings, MATCH_ID: id});
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
    expect(
      jsonObjects(jsonObject(playerView.body).versions).map(row => row.version),
    ).toEqual([2, 1]);
    expect(jsonObject(playerView.body).replayAvailable).toBe(true);
    expect(jsonObject(playerView.body).downloads).toEqual([]);
    expect((await call(`${history}/replay`, undefined, p1)).status).toBe(200);
    expect(
      (await call(`${history}/download/replay`, undefined, p1)).status,
    ).toBe(403);
    await ageSession();
    expect(jsonObject((await call(history)).body).downloads).toEqual([
      'report',
      'audit',
      'replay',
      'backup',
    ]);
    const report = await call(`${history}/download/report?version=1`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(jsonObject(report.body).fileName).toContain('第1版');
    const data = jsonObject(
      parseJson(jsonString(jsonObject(report.body).text)),
    );
    expect(jsonObject(data.report).version).toBe(1);
    expect(jsonArray(jsonObject(data.report).standings)[0]).not.toHaveProperty(
      'homeworld',
    );
    expect(jsonObject(report.body).text).not.toContain('credential_hash');
    expect((await call(`${history}/download/audit`)).status).toBe(200);
    const backup = await call(`${history}/download/backup`);
    expect(backup.status, JSON.stringify(backup.body)).toBe(200);
    const envelope = jsonObject(
      parseJson(jsonString(jsonObject(backup.body).text)),
    );
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
    expect(
      (await call(`${history}/report?version=1`, undefined, candidate)).status,
    ).toBe(403);
    expect(
      (await call(`${history}/download/audit`, undefined, candidate)).status,
    ).toBe(403);
  });
  it('旧比赛接入保留对象与发行事实，旧口令只能领取一次长期账号', async () => {
    const legacy = bindings.MATCH_DO.getByName('match:integration');
    const accounts = await Promise.all(
      [
        {id: 'C01', role: 'player', name: '同名'},
        {id: 'C02', role: 'player', name: '同名'},
        {id: 'J01', role: 'judge', name: '总裁判', duty: 'head'},
        {id: 'J02', role: 'judge', name: '通讯裁判', duty: 'communications'},
        {id: 'J03', role: 'judge', name: '事件裁判', duty: 'events'},
      ].map(async a => ({
        ...a,
        credential_hash: await digest(
          `legacy-credential-${a.id}-long-enough-for-test`,
        ),
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
    const inventory = jsonObject(
      parseJson(
        await platform().maintenance(
          'integration-platform-maintenance-secret',
          {
            ...args,
            operation: 'inspect-legacy',
          },
        ),
      ),
    );
    const reply = jsonObject(
      parseJson(
        await platform().maintenance(
          'integration-platform-maintenance-secret',
          {
            ...args,
            operation: 'adopt-legacy',
            name: '既有比赛',
            checkpointDigest: await digest(stableJson(inventory.checkpoint)),
            confirm: '接入旧比赛 integration',
          },
        ),
      ),
    );
    expect(jsonObject(reply.receipt).accounts).toBe(5);
    const one = await activate(
      'legacy-credential-C01-long-enough-for-test',
      'player',
    );
    const two = await activate(
      'legacy-credential-C02-long-enough-for-test',
      'player',
    );
    expect(one.session.account.id).not.toBe(two.session.account.id);
    const snapshot = await call(
      '/matches/integration/snapshot?route=/player',
      undefined,
      one,
    );
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    expect(jsonObject(jsonObject(snapshot.body).session).id).toBe('C01');
    expect(
      (
        await call('/auth/claim', {
          invitation: 'legacy-credential-C01-long-enough-for-test',
        })
      ).status,
    ).toBe(401);
  });
  it('申诉保留与7天清理等待生效，清理后保留战报并禁止读取完整复盘或启动旧恢复', async () => {
    const {id, p1} = await running();
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      async (_instance, state) => {
        const db = new Store(state.storage);
        const e = new Engine(db, {...bindings, MATCH_ID: id});
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
      const d = jsonObjects((await call('/platform/matches')).body).find(
        m => m.id === id,
      );
      const payload = {
        matchId: id,
        expected_version: jsonObject(d).version,
        reason: '清理边界核对',
        ...extra,
      };
      const preview = await call('/platform/preview', {path, payload});
      return call(path, {
        ...payload,
        request_id: crypto.randomUUID(),
        preview_token: jsonObject(preview.body).previewToken,
      });
    };
    const history = `/matches/${id}/history`;
    expect((await call(`${history}/download/replay`)).status).toBe(200);
    const reportBeforeCleanup = jsonObject(
      (await call(`${history}/report?version=1`, undefined, p1)).body,
    ).report;
    expect((await mutation('/platform/data/purge', {})).status).toBe(409);
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      (_instance, state) =>
        new Store(state.storage).exec(
          'UPDATE matches SET ended_utc=?',
          Date.now() - 50 * 86400000,
        ),
    );
    expect(
      (
        await mutation('/platform/data/hold', {
          reviewUtc: Date.now() + 86400000,
        })
      ).status,
    ).toBe(200);
    expect((await mutation('/platform/data/purge', {})).status).toBe(409);
    expect(
      (await mutation('/platform/data/hold', {release: true})).status,
    ).toBe(200);
    const purge = await mutation('/platform/data/purge', {});
    expect(purge.status).toBe(202);
    await drain();
    expect(
      jsonObject(
        (
          await call(
            `/platform/operations/${jsonString(jsonObject(purge.body).operationId)}`,
          )
        ).body,
      ).status,
    ).toBe('pending');
    // Advance only the persistent queue's due marker; no wall-clock wait or real-time schedule runs.
    await runInDurableObject(platform(), (_instance, state) =>
      new Store(state.storage).exec(
        'UPDATE platform_operations SET next_attempt=0 WHERE id=?',
        jsonString(jsonObject(purge.body).operationId),
      ),
    );
    await drain();
    const completed = await call(
      `/platform/operations/${jsonString(jsonObject(purge.body).operationId)}`,
    );
    expect(
      jsonObject(completed.body).status,
      JSON.stringify(completed.body),
    ).toBe('succeeded');
    expect(
      (await call(`/matches/${id}/snapshot?route=/results`, undefined, p1))
        .status,
    ).toBe(410);
    expect((await call(`${history}/replay`, undefined, p1)).status).toBe(410);
    expect((await call(`${history}/download/backup`)).status).toBe(410);
    expect(
      (await call(`${history}/report?version=1`, undefined, p1)).status,
    ).toBe(200);
    expect(
      jsonObject(
        (await call(`${history}/report?version=1`, undefined, p1)).body,
      ).report,
    ).toEqual(reportBeforeCleanup);
    expect((await call(`${history}/download/audit`)).status).toBe(200);
    // Simulate the match database losing its cleanup marker after a rollback. The
    // platform database still denies a launch and any sensitive download.
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      (_instance, state) => {
        const db = new Store(state.storage);
        db.exec('UPDATE match_identity SET erasure_generation=0');
        db.exec('UPDATE matches SET ended_utc=?', Date.now());
      },
    );
    expect((await call(`${history}/download/replay`)).status).toBe(410);
    await runInDurableObject(platform(), async instance => {
      await expect(
        instance.maintenance('integration-platform-maintenance-secret', {
          operation: 'recovery',
          operationId: 'launch-after-cleanup',
          matchId: id,
          reason: '验证清理记录拦住旧检查点',
          payload: {operation: 'launch', payload: {}},
        }),
      ).rejects.toThrow('本场完整信息已清理');
    });
  });
  it('恢复启动前必须有本地材料回读收据，凭据撤销不随本场检查点回退', async () => {
    const {id, p1} = await running();
    const target = await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      async (_instance, state) => {
        const e = new Engine(new Store(state.storage), {
          ...bindings,
          MATCH_ID: id,
        });
        return createCheckpoint(e);
      },
    );
    const base = {
      operationId: 'recovery-gate',
      matchId: id,
      reason: '受控恢复流程检查',
    };
    const carry = jsonObject(
      parseJson(
        await platform().maintenance(
          'integration-platform-maintenance-secret',
          {
            ...base,
            operation: 'recovery',
            payload: {
              operation: 'prepare',
              payload: {target, reason: base.reason},
            },
          },
        ),
      ),
    );
    await runInDurableObject(platform(), async instance => {
      await expect(
        instance.maintenance('integration-platform-maintenance-secret', {
          ...base,
          operation: 'recovery',
          confirm: `恢复比赛 ${id}`,
          payload: {operation: 'launch', payload: carry},
        }),
      ).rejects.toThrow('必须保存');
    });
    const saved = jsonObject(
      parseJson(
        await platform().maintenance(
          'integration-platform-maintenance-secret',
          {
            ...base,
            operation: 'carry-receipt',
            carry,
            sha256: await digest(stableJson(carry)),
          },
        ),
      ),
    );
    expect(saved.saved).toBe(true);
    const accountId = p1.session.account.id;
    const account = jsonObjects((await call('/platform/accounts')).body).find(
      a => a.id === accountId,
    );
    const payload = {
      accountId,
      status: 'disabled',
      expected_version: jsonObject(account).version,
      reason: '保全材料生成后停用账号',
    };
    const preview = await call('/platform/preview', {
      path: '/platform/accounts/status',
      payload,
    });
    expect(
      (
        await call('/platform/accounts/status', {
          ...payload,
          request_id: 'fence-during-recovery',
          preview_token: jsonObject(preview.body).previewToken,
        })
      ).status,
    ).toBe(202);
    await drain();
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      async (_instance, state) => {
        const e = new Engine(new Store(state.storage), {
          ...bindings,
          MATCH_ID: id,
        });
        restoreCheckpointTables(e, (await openCheckpoint(e, target)).tables);
      },
    );
    const recovered = jsonObject(
      parseJson(
        await platform().maintenance(
          'integration-platform-maintenance-secret',
          {
            ...base,
            operation: 'recovery',
            payload: {operation: 'complete', payload: carry},
          },
        ),
      ),
    );
    expect(recovered.id).toBe(carry.id);
    expect(
      (await call(`/matches/${id}/snapshot?route=/player`, undefined, p1))
        .status,
    ).toBe(401);
    await runInDurableObject(
      bindings.MATCH_DO.getByName(`match:${id}`),
      (_instance, state) => {
        const db = new Store(state.storage);
        expect(
          db.one<Record<string, SqlStorageValue>>(
            'SELECT disabled FROM authorization_fences WHERE account_id=?',
            accountId,
          ),
        ).toEqual({disabled: 1});
        expect(db.match().recovery_state).toMatch(/^review:/);
      },
    );
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
        headers: {
          Origin: 'https://game.test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({credential: owner.credential, audience: 'staff'}),
      }),
      gatewayEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('df_staff_local=');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const rejected = await gateway(
      new Request('https://game.test/api/platform/matches/create', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.test',
          'Content-Type': 'application/json',
        },
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
            headers: {
              Origin: 'https://game.test',
              'Content-Type': 'application/json',
            },
            body: '{}',
          }),
          gatewayEnv,
        )
      ).status,
    ).toBe(409);
  });
  it('档案管理员只发现获授权比赛，无法预览他场清理或全局账号操作', async () => {
    const a = await match('授权场');
    const b = await match('未授权场');
    const archivist = await account('档案工作人员');
    const payload = {
      accountId: archivist.session.account.id,
      role: 'archivist',
      matchId: a,
      enabled: true,
      expected_version: archivist.session.account.version,
      reason: '授予单场档案管理权限',
    };
    const preview = await call('/platform/preview', {
      path: '/platform/roles/update',
      payload,
    });
    const grant = await call('/platform/roles/update', {
      ...payload,
      request_id: 'scoped-archive-role',
      preview_token: jsonObject(preview.body).previewToken,
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    expect(
      jsonObjects(
        (await call('/platform/matches', undefined, archivist)).body,
      ).map(m => m.id),
    ).toEqual([a]);
    expect(
      (
        await call(
          '/platform/preview',
          {path: '/platform/data/purge', payload: {matchId: b}},
          archivist,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          '/platform/preview',
          {
            path: '/platform/accounts/status',
            payload: {accountId: owner.session.account.id},
          },
          archivist,
        )
      ).status,
    ).toBe(403);
  });
  it('第二因素验证码及恢复码不可重复使用', async () => {
    const setup = await call('/me/security/setup', {});
    expect(setup.status).toBe(200);
    const code = await totp(
      jsonString(jsonObject(setup.body).secret),
      Math.floor(Date.now() / 30000),
    );
    const confirmed = await call('/me/security/confirm', {code});
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(
      (
        await call('/auth/exchange', {
          credential: owner.credential,
          audience: 'staff',
          code,
        })
      ).status,
    ).toBe(401);
    const recovery = jsonArray(jsonObject(confirmed.body).recoveryCodes)[0];
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
    const code = await totp(
      jsonString(jsonObject(setup.body).secret),
      Math.floor(Date.now() / 30000),
    );
    expect((await call('/me/security/confirm', {code})).status).toBe(200);
    expect(
      jsonObject((await call('/auth/session')).body).secondFactorEnabled,
    ).toBe(true);
    expect((await call('/me/security/disable', {})).status).toBe(200);
    expect(
      jsonObject((await call('/auth/session')).body).secondFactorEnabled,
    ).toBe(false);
    expect(
      (
        await call('/auth/exchange', {
          credential: owner.credential,
          audience: 'staff',
        })
      ).status,
    ).toBe(200);
    expect(
      await runInDurableObject(platform(), (_instance, state) =>
        new Store(state.storage).all<Record<string, SqlStorageValue>>(
          'SELECT * FROM recovery_codes',
        ),
      ),
    ).toEqual([]);
  });
  it('会话未验证第二因素时仍不能关闭，验证成功后不设置近期认证时限', async () => {
    const login = owner;
    const setup = await call('/me/security/setup', {});
    const code = await totp(
      jsonString(jsonObject(setup.body).secret),
      Math.floor(Date.now() / 30000),
    );
    const confirmed = await call('/me/security/confirm', {code});
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
    expect(jsonObject(denied.body).code).toBe('SECOND_FACTOR_REQUIRED');
    expect(
      (
        await call(
          '/auth/reauth',
          {credential: owner.credential, code: 'invalid'},
          login,
        )
      ).status,
    ).toBe(401);
    const verified = await call(
      '/auth/reauth',
      {
        credential: owner.credential,
        code: jsonArray(jsonObject(confirmed.body).recoveryCodes)[0],
      },
      login,
    );
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(jsonObject(verified.body).secondFactor).toBe(true);
    await ageSession(login, 11 * 3600000);
    expect((await call('/me/security/disable', {}, login)).status).toBe(200);
  });
});
