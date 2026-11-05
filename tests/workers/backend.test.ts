import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  reset,
  runInDurableObject,
  evictDurableObject,
  runDurableObjectAlarm,
} from 'cloudflare:test';
import type { BackendEnv, RpcInput } from '../../apps/match-worker/src/rpc/types';
import { digest } from '../../apps/match-worker/src/security/crypto';
import { gateway } from '../../apps/web/functions/_lib/gateway';
import { Engine } from '../../apps/match-worker/src/services/engine';
import { Store } from '../../apps/match-worker/src/storage/store';
import type { Snapshot, Arms, OperationResult, ScheduledEvent } from '@darkforest/contracts';
import { decodeArms } from '../../apps/match-worker/src/domain/rules';
import { retire } from '../../apps/match-worker/src/services/life';
import { decrypt } from '../../apps/match-worker/src/security/crypto';

const bindings = env as unknown as BackendEnv;
const stub = () => bindings.MATCH_DO.getByName('match:integration');
const password = (id: string) => `integration-credential-for-${id}-long-enough`;
type Login = { token: string; csrf: string };
let testUtc: number | undefined;
async function call(path: string, body?: unknown, login?: Login) {
  const input: RpcInput = {
    method: body === undefined ? 'GET' : 'POST',
    path,
    clientKey: 'test',
    edgeUtc: Date.now(),
    ...(body === undefined ? {} : { body }),
    ...(login ? { token: login.token, csrf: login.csrf } : {}),
  };
  if (testUtc !== undefined)
    return runInDurableObject(stub(), async (_instance, state) => {
      const engine = new Engine(new Store(state.storage), bindings);
      engine.now = () => testUtc!;
      return engine.call({ ...input, edgeUtc: testUtc! });
    });
  const reply = await stub().call(input);
  return { ...reply, body: JSON.parse(reply.body) as unknown };
}
async function seed(n = 3) {
  const accounts = await Promise.all(
    [
      ...Array.from({ length: n }, (_, i) => ({
        id: `C${String(i + 1).padStart(2, '0')}`,
        role: 'player',
        name: `文明${i + 1}`,
      })),
      ...['head', 'communications', 'events'].map((duty, i) => ({
        id: `J0${i + 1}`,
        role: 'judge',
        name: duty,
        duty,
      })),
    ].map(async (a) => ({ ...a, credential_hash: await digest(password(a.id)) })),
  );
  const reply = await stub().bootstrap('integration-only-bootstrap-secret', {
    match_id: 'integration',
    accounts,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
}
async function login(id: string): Promise<Login> {
  const reply = await call('/auth/exchange', {
    credential: password(id),
    audience: id.startsWith('J') ? 'judge' : 'player',
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return { token: reply.sessionToken!, csrf: (reply.body as { csrfToken: string }).csrfToken };
}
let sequence = 0;
async function action(
  path: string,
  login: Login,
  payload: Record<string, unknown> = {},
  request_id = `test-${++sequence}`,
) {
  return call(path, { ...payload, request_id }, login);
}
async function manage(path: string, login: Login, payload: Record<string, unknown> = {}) {
  const snapshot = await call('/public/match');
  const revision = (snapshot.body as { revision: number }).revision;
  const preview = await action('/judge/manage/preview', login, {
    path,
    ...payload,
    reason: '集成测试',
    change: '确认操作',
    expected_revision: revision,
  });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const token = (preview.body as { preview: { token: string } }).preview.token;
  return action(path, login, {
    ...payload,
    reason: '集成测试',
    expected_revision: revision,
    preview_token: token,
  });
}
beforeEach(async () => {
  await reset();
  sequence = 0;
  testUtc = undefined;
});
async function start(n = 3, accountCount = n, candidateHomes = false) {
  await seed(accountCount);
  testUtc = Date.now();
  const head = await login('J01');
  if (candidateHomes)
    for (let i = n; i < accountCount; i++) {
      const target = `C${String(i + 1).padStart(2, '0')}`,
        p = await login(target),
        code = String(i + 1).padStart(6, '0');
      expect((await action('/player/nickname', p, { nickname: `候选${i + 1}` })).status).toBe(200);
      expect((await action('/action/homeworld-submit', p, { code })).status).toBe(200);
      expect(
        (
          await action(`/judge/homeworld/${target}/verify`, head, {
            expected_version: 1,
            expected_code: code,
            decision: 'approve',
          })
        ).status,
      ).toBe(200);
    }
  if (accountCount !== n)
    expect(
      (
        await manage('/judge/roster', head, {
          members: Array.from({ length: n }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
        })
      ).status,
    ).toBe(200);
  const players: Login[] = [];
  for (let i = 0; i < n; i++) {
    const id = `C${String(i + 1).padStart(2, '0')}`,
      p = await login(id);
    players.push(p);
    expect((await action('/player/nickname', p, { nickname: `文明${i + 1}` })).status).toBe(200);
    expect(
      (await action('/action/homeworld-submit', p, { code: String(i + 1).padStart(6, '0') }))
        .status,
    ).toBe(200);
    expect(
      (
        await action(`/judge/homeworld/${id}/verify`, head, {
          expected_version: 1,
          expected_code: String(i + 1).padStart(6, '0'),
          decision: 'approve',
        })
      ).status,
    ).toBe(200);
    expect((await action('/action/preflight-depart', p)).status).toBe(200);
    expect((await action('/action/preflight-stage', p)).status).toBe(200);
  }
  const expected_roster = players.map((_, i) => `C${String(i + 1).padStart(2, '0')}`);
  expect(
    (await manage('/judge/arm-code-release', head, { time: testUtc + 2000, expected_roster }))
      .status,
  ).toBe(200);
  testUtc += 2000;
  const codes = await Promise.all(players.map((p) => action('/action/preflight-issue-code', p)));
  codes.forEach((r) => expect(r.status, JSON.stringify(r.body)).toBe(200));
  const arms: Arms[] = [];
  for (const p of players) {
    arms.push(((await call('/player/self', undefined, p)).body as { arms: Arms }).arms);
    expect((await action('/action/preflight-ready', p)).status).toBe(200);
  }
  expect(
    (await manage('/judge/arm-start', head, { time: testUtc + 2000, expected_roster })).status,
  ).toBe(200);
  testUtc += 2000;
  expect((await call('/public/match')).body).toMatchObject({
    stage: 'forest',
    gameMs: 0,
    total: n,
  });
  return { head, players, arms, startUtc: testUtc };
}
async function inEngine<T>(fn: (engine: Engine) => T | Promise<T>): Promise<T> {
  return runInDurableObject(stub(), async (_instance, state) => {
    const engine = new Engine(new Store(state.storage), bindings);
    if (testUtc !== undefined) engine.now = () => testUtc!;
    await engine.keys();
    return fn(engine);
  });
}
async function previewFromJudge(path: string, head: Login, payload: Record<string, unknown> = {}) {
  const snapshot = await call('/snapshot?route=%2Fjudge', undefined, head);
  expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
  return action('/judge/manage/preview', head, {
    path,
    ...payload,
    reason: '审计问题回归',
    expected_revision: (snapshot.body as Snapshot).match!.revision,
  });
}
async function executePreview(
  path: string,
  head: Login,
  preview: OperationResult,
  payload: Record<string, unknown> = {},
) {
  return action(path, head, {
    ...payload,
    reason: '审计问题回归',
    expected_revision: preview.preview!.revision,
    preview_token: preview.preview!.token,
  });
}

describe('audit fixes without a complete command language', () => {
  it('restores a legacy terminal-stage ruling using its retired voyage evidence', async () => {
    const { head, players, startUtc } = await start(4);
    testUtc = startUtc + 98 * 60_000;
    await call('/public/match');
    expect(
      (
        await manage('/judge/hunt-finalize', head, {
          eliminations: [{ id: 'C02', reason: 'no_share_at_cutoff' }],
        })
      ).status,
    ).toBe(200);
    await inEngine((e) => e.db.exec("DELETE FROM judge_eliminations WHERE player_id='C02'"));
    expect((await manage('/judge/pause', head)).status).toBe(200);
    expect((await manage('/judge/player-restore', head, { target: 'C02' })).status).toBe(200);
    expect((await call('/player/self', undefined, players[1])).body).toMatchObject({
      flight: 'issued',
      homeAlive: false,
      observerAllowed: false,
    });
  });
  it('accepts the shared homeworld wire shape through the real HTTP gateway and rejects stale extra fields', async () => {
    await seed();
    const player = await login('C01');
    await action('/player/nickname', player, { nickname: '登记回归' });
    const submit = (body: Record<string, unknown>) =>
      gateway(
        new Request('http://local.test/api/action/homeworld-submit', {
          method: 'POST',
          headers: {
            origin: 'http://local.test',
            'content-type': 'application/json',
            cookie: `df_session_local=${player.token}`,
            'x-csrf-token': player.csrf,
          },
          body: JSON.stringify(body),
        }),
        {
          APP_ENV: 'local',
          MATCH_ID: 'integration',
          TRUSTED_ORIGINS: 'http://local.test',
          MATCH_DO: bindings.MATCH_DO,
        },
      );
    const saved = await submit({ code: '001234', request_id: 'ui-homeworld' });
    expect(saved.status).toBe(200);
    expect((await call('/player/self', undefined, player)).body).toMatchObject({
      homeworld: '001234',
      homeVersion: 1,
      flight: 'pending',
    });
    expect(
      (await submit({ code: '001235', request_id: 'old-ui', expected_version: 1 })).status,
    ).toBe(400);
    expect((await submit({ code: '001235', request_id: 'resubmit-ui' })).status).toBe(200);
    expect((await call('/player/self', undefined, player)).body).toMatchObject({
      homeworld: '001235',
      homeVersion: 2,
    });
  });

  it('excludes approved candidate homes from reverse intel, song and photon matching', async () => {
    const { head, players } = await start(3, 4, true),
      candidate = await login('C04');
    expect((await action('/action/broadcast', players[0]!, { code: '000004' })).status).toBe(200);
    expect((await call('/player/intel', undefined, candidate)).body).toEqual([]);
    expect(
      ((await call('/snapshot?route=%2Fplayer', undefined, candidate)).body as Snapshot).intel,
    ).toEqual([]);
    await inEngine((e) => {
      e.db.exec('UPDATE players SET tech=1,photons=1 WHERE id=?', 'C02');
    });
    expect((await action('/action/photon', players[1]!, { code: '000004' })).status).toBe(200);
    await manage('/judge/pause', head);
    const trigger = await manage('/judge/event-trigger', head, {
      kind: 'song_visit',
      code: '000004',
    });
    expect(trigger.status, JSON.stringify(trigger.body)).toBe(200);
    expect(await inEngine((e) => e.db.home('C04')!.destroyed_game)).toBeNull();
    expect(
      await inEngine((e) =>
        e.db.all(
          "SELECT id FROM notice_queue WHERE target='C04' AND title IN ('收到母星情报','母星毁灭','永久淘汰')",
        ),
      ),
    ).toEqual([]);
    expect((await action('/action/broadcast', players[0]!, { code: '000002' })).status).toBe(409); // pause remains a separate gate
    await manage('/judge/resume', head);
    expect((await action('/action/broadcast', players[0]!, { code: '000002' })).status).toBe(200);
    expect((await call('/player/intel', undefined, players[1])).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ civilization: 'C01', code: '000001' })]),
    );
  });

  it.each([900, 240, 3600])(
    'projects the real earlier respawn cutoff for a %i second personal deadline',
    async (seconds) => {
      const { players, arms, startUtc } = await start();
      await inEngine((e) =>
        e.db.exec(
          "UPDATE settings SET value=json_set(value,'$.respawnSeconds',?) WHERE key='parameters'",
          seconds,
        ),
      );
      testUtc = startUtc + 60 * 60_000;
      expect(
        (await action('/action/sighting', players[0]!, { arm_a: arms[1]![0], arm_b: arms[1]![1] }))
          .status,
      ).toBe(200);
      const self = (await call('/player/self', undefined, players[1])).body as Snapshot['player'];
      expect(self!.respawnDeadline).toBe(Math.min(60 * 60_000 + seconds * 1000, 65 * 60_000));
      const projected = (
        (await call('/snapshot?route=%2Fplayer%2Frespawn', undefined, players[1])).body as Snapshot
      ).player;
      expect(projected!.respawnDeadline).toBe(self!.respawnDeadline);
      testUtc = startUtc + Math.min(60 * 60_000 + seconds * 1000, 65 * 60_000);
      expect((await call('/player/self', undefined, players[1])).body).toMatchObject({
        flight: 'eliminated',
        actions: [],
      });
    },
  );

  it.each([0, 66 * 60_000, 99 * 60_000])(
    'restores an erroneous manual elimination at game time %i without reviving its old code',
    async (game) => {
      const { head, players, arms, startUtc } = await start(4);
      if (game >= 99 * 60_000) {
        testUtc = startUtc + 98 * 60_000;
        await call('/public/match');
        expect((await manage('/judge/hunt-finalize', head, { eliminations: [] })).status).toBe(200);
      }
      testUtc = startUtc + game;
      expect((await manage('/judge/player-eliminate', head, { target: 'C02' })).status).toBe(200);
      testUtc += 181_000;
      expect((await call('/observer/overview', undefined, players[1])).status).toBe(200);
      expect((await manage('/judge/pause', head)).status).toBe(200);
      const p = await previewFromJudge('/judge/player-restore', head, { target: 'C02' });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect((p.body as OperationResult).preview!.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: '尚可发行配置', before: '346', after: '345' }),
        ]),
      );
      const restored = await executePreview(
        '/judge/player-restore',
        head,
        p.body as OperationResult,
        { target: 'C02' },
      );
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect((await call('/player/self', undefined, players[1])).body).toMatchObject({
        flight: 'issued',
        flightNumber: 2,
        observerAllowed: false,
        eliminatedAt: null,
      });
      expect((await call('/observer/overview', undefined, players[1])).status).toBe(403);
      expect(
        (await manage('/judge/equipment-correction', head, { target: 'C02', mode: 'activate' }))
          .status,
      ).toBe(200);
      const next = (await call('/player/self', undefined, players[1])).body as NonNullable<
        Snapshot['player']
      >;
      expect(next.flight).toBe('active');
      expect(next.arms).not.toEqual(arms[1]);
      expect((await call('/player/self', undefined, players[1])).body).toMatchObject({
        homeAlive: game === 0,
      });
      expect(
        await inEngine((e) =>
          e.db.all("SELECT id FROM sighting_codes WHERE player_id='C02' AND status='retired'"),
        ),
      ).toHaveLength(1);
      expect((await manage('/judge/resume', head)).status).toBe(200);
    },
  );

  it('keeps fault reading, pause and cancellation reachable while a due event persistently fails', async () => {
    const { head, players } = await start();
    await inEngine((e) =>
      e.db.exec(
        "INSERT INTO scheduled_events(id,kind,clock,due,priority,payload) VALUES('broken-song','song_visit','game',0,2,'{')",
      ),
    );
    expect((await action('/action/broadcast', players[0]!, { code: '000003' })).status).toBe(503);
    const snapshot = await call('/snapshot?route=%2Fjudge', undefined, head);
    expect(snapshot.status).toBe(200);
    expect((snapshot.body as Snapshot).judge!.scheduler.error).not.toBe('');
    const details = await call('/judge/events/broken-song', undefined, head);
    expect(details.status).toBe(200);
    expect(details.body).toMatchObject({
      status: 'pending',
      attempts: expect.any(Number),
      payload: { invalid: true },
    });
    expect((details.body as ScheduledEvent).attempts).toBeGreaterThan(0);
    expect((await call('/judge/events/broken-song', undefined, players[0])).status).not.toBe(200);
    const pause = await previewFromJudge('/judge/pause', head);
    expect(pause.status).toBe(200);
    expect((await executePreview('/judge/pause', head, pause.body as OperationResult)).status).toBe(
      200,
    );
    const retry = await previewFromJudge('/judge/event-control', head, {
      event_id: 'broken-song',
      operation: 'retry',
    });
    expect(retry.status).toBe(200);
    expect(
      (
        await executePreview('/judge/event-control', head, retry.body as OperationResult, {
          event_id: 'broken-song',
          operation: 'retry',
        })
      ).status,
    ).toBe(503);
    const cancel = await previewFromJudge('/judge/event-control', head, {
      event_id: 'broken-song',
      operation: 'cancel',
    });
    expect(cancel.status).toBe(200);
    expect(
      (
        await executePreview('/judge/event-control', head, cancel.body as OperationResult, {
          event_id: 'broken-song',
          operation: 'cancel',
        })
      ).status,
    ).toBe(200);
    expect((await call('/public/match')).status).toBe(200);
    expect((await call('/judge/events/broken-song', undefined, head)).body).toMatchObject({
      status: 'cancelled',
    });
    expect(
      (
        await previewFromJudge('/judge/event-control', head, {
          event_id: 'broken-song',
          operation: 'retry',
        })
      ).status,
    ).toBe(409);
    expect((await manage('/judge/resume', head)).status).toBe(200);
    expect((await action('/action/broadcast', players[0]!, { code: '000003' })).status).toBe(200);
  });

  it('reports all unsent notices and separates copy/send actors and immutable action history', async () => {
    const { head } = await start(),
      communications = await login('J02'),
      events = await login('J03');
    const noticeId = await inEngine((e) => {
      e.db.exec("UPDATE notice_queue SET status='sent'");
      e.notice('old-important', 'C01', '飞船被击毁', '较早尚未发送的通知');
      for (let i = 0; i < 110; i++) {
        e.notice(`new-sent:${i}`, 'group', '普通公告', '已发送');
        e.db.exec(
          "UPDATE notice_queue SET status='sent' WHERE dedup_key=?",
          `new-sent:${i}|group|普通公告`,
        );
      }
      return e.db.one<{ id: string }>("SELECT id FROM notice_queue WHERE status!='sent'")!.id;
    });
    const snapshot = (await call('/snapshot?route=%2Fjudge', undefined, head)).body as Snapshot;
    expect(snapshot.judge!.notices).toHaveLength(100);
    expect(snapshot.judge!.notices.some((n) => n.id === noticeId)).toBe(false);
    expect(snapshot.judge!.noticePendingCount).toBe(1);
    expect(snapshot.judge!.noticeTasks![0]!.id).toBe(noticeId);
    expect(
      (await action(`/judge/notices/${noticeId}/copied`, communications, { expected_version: 1 }))
        .status,
    ).toBe(200);
    testUtc! += 1000;
    expect(
      (await action(`/judge/notices/${noticeId}/sent`, events, { expected_version: 2 })).status,
    ).toBe(200);
    const state = await inEngine((e) => ({
      notice: e.db.one(
        'SELECT copied_by,copied_utc,sent_by,sent_utc FROM notice_queue WHERE id=?',
        noticeId,
      ),
      actions: e.db.all(
        'SELECT actor,action FROM notice_actions WHERE notice_id=? ORDER BY utc_ms',
        noticeId,
      ),
    }));
    expect(state.notice).toMatchObject({
      copied_by: 'communications',
      sent_by: 'events',
      sent_utc: testUtc,
    });
    expect(state.actions).toEqual([
      { actor: 'J02', action: 'copied' },
      { actor: 'J03', action: 'sent' },
    ]);
    expect(
      (
        await action(`/judge/notices/${noticeId}/error`, communications, {
          expected_version: 2,
          reason: '过期页面',
        })
      ).status,
    ).toBe(409);
    expect(
      ((await call('/snapshot?route=%2Fjudge', undefined, head)).body as Snapshot).judge!
        .noticePendingCount,
    ).toBe(0);
  });

  it('previews authoritative resources, persists before/after audit facts and records failed management', async () => {
    const { head, startUtc } = await start();
    testUtc = startUtc + 123456;
    const p = await previewFromJudge('/judge/correction', head, {
      target: 'C01',
      field: 'photons',
      value: '1',
      change: '假的当前状态',
    });
    expect(p.status).toBe(200);
    expect((p.body as OperationResult).preview!.changes).toEqual([
      { target: 'C01光粒', before: '0', after: '1' },
      { target: 'C01技术升级', before: '0', after: '1' },
    ]);
    expect(
      (
        await executePreview('/judge/correction', head, p.body as OperationResult, {
          target: 'C01',
          field: 'photons',
          value: '1',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await executePreview('/judge/correction', head, p.body as OperationResult, {
          target: 'C01',
          field: 'photons',
          value: '1',
        })
      ).status,
    ).toBe(409);
    const audits = await inEngine((e) =>
      e.db
        .all<{ detail: string; game_ms: number }>(
          "SELECT detail,game_ms FROM audit_logs WHERE action='/judge/correction' ORDER BY seq",
        )
        .map((row) => ({ ...JSON.parse(row.detail), game: row.game_ms })),
    );
    expect(audits.map((a) => a.status)).toEqual(['previewed', 'executed', 'failed']);
    expect(audits[1].before.players.find((p: { id: string }) => p.id === 'C01').photons).toBe(0);
    expect(audits[1].after.players.find((p: { id: string }) => p.id === 'C01').photons).toBe(1);
    expect(audits[1].preview.changes).toEqual((p.body as OperationResult).preview!.changes);
    expect(audits[1].game).toBe(123456);
    const projected = (
      (await call('/snapshot?route=%2Fjudge%2Faudit', undefined, head)).body as Snapshot
    ).judge!.audits;
    expect(projected.find((a) => a.status === 'executed')!.before).toContain('"photons": 0');
    expect(JSON.stringify(audits)).not.toContain('credential_hash');
    expect(JSON.stringify(audits)).not.toContain('ciphertext');
  });

  it('queries planned events, rejects early retry and executes manual events exactly once', async () => {
    const { head, players } = await start();
    const list = await call('/judge/events', undefined, head);
    expect(list.status).toBe(200);
    expect(
      (list.body as ScheduledEvent[]).some((e) => e.id === 'apocalypse' && e.status === 'pending'),
    ).toBe(true);
    expect(
      (
        await previewFromJudge('/judge/event-control', head, {
          event_id: 'tech:0',
          operation: 'retry',
        })
      ).status,
    ).toBe(409);
    await manage('/judge/pause', head);
    const p = await previewFromJudge('/judge/event-trigger', head, {
      kind: 'song_visit',
      code: '000002',
    });
    const payload = {
      kind: 'song_visit',
      code: '000002',
      reason: '审计问题回归',
      preview_token: (p.body as OperationResult).preview!.token,
      expected_revision: (p.body as OperationResult).preview!.revision,
    };
    const r = await action('/judge/event-trigger', head, payload, 'manual-song-once');
    expect(r.status).toBe(200);
    expect((r.body as OperationResult).scheduler!.settledEvents).toHaveLength(1);
    expect((await action('/judge/event-trigger', head, payload, 'manual-song-once')).body).toEqual(
      r.body,
    );
    expect((await call('/player/self', undefined, players[1])).body).toMatchObject({
      flight: 'active',
      homeAlive: false,
    });
    expect(
      await inEngine((e) => e.db.all("SELECT id FROM event_log WHERE kind='singer'")),
    ).toHaveLength(1);
    const settled = (r.body as OperationResult).scheduler!.settledEvents[0]!;
    expect(
      (await manage('/judge/event-control', head, { event_id: settled, operation: 'retry' }))
        .status,
    ).toBe(200);
    expect(
      await inEngine((e) => e.db.all("SELECT id FROM event_log WHERE kind='singer'")),
    ).toHaveLength(1);
  });
});
describe('real Workers SQLite and RPC', () => {
  it('boots once, authenticates separate roles, persists through object eviction', async () => {
    await seed();
    const p = await login('C01');
    expect((await action('/player/nickname', p, { nickname: 'Alpha' })).status).toBe(200);
    await evictDurableObject(stub());
    expect((await call('/player/self', undefined, p)).body).toMatchObject({
      nickname: 'Alpha',
      actions: expect.arrayContaining(['homeworld-submit']),
    });
    expect(
      (
        await stub().bootstrap('integration-only-bootstrap-secret', {
          match_id: 'integration',
          accounts: [],
        })
      ).status,
    ).not.toBe(201);
  });
  it('enforces foreign keys, CHECK, partial unique indexes and whole-transaction rollback', async () => {
    await seed();
    await runInDurableObject(stub(), (_instance, state) => {
      expect(() => state.storage.sql.exec("INSERT INTO players(id) VALUES('missing')")).toThrow();
      expect(() => state.storage.sql.exec("UPDATE players SET photons=2 WHERE id='C01'")).toThrow();
      expect(() =>
        state.storage.transactionSync(() => {
          state.storage.sql.exec("UPDATE players SET nickname='临时昵称' WHERE id='C01'");
          state.storage.sql.exec("UPDATE players SET photons=2 WHERE id='C02'");
        }),
      ).toThrow();
      expect(
        state.storage.sql.exec("SELECT nickname FROM players WHERE id='C01'").one().nickname,
      ).toBeNull();
    });
  });
  it('supports case-sensitive nicknames and rejects hidden or equivalent duplicate names', async () => {
    await seed();
    const a = await login('C01'),
      b = await login('C02'),
      c = await login('C03');
    expect((await action('/player/nickname', a, { nickname: 'Alpha' })).status).toBe(200);
    expect((await action('/player/nickname', b, { nickname: 'alpha' })).status).toBe(200);
    expect((await action('/player/nickname', c, { nickname: 'Ａｌｐｈａ' })).status).toBe(409);
    expect((await action('/player/nickname', c, { nickname: '隐\u200b藏' })).status).toBe(400);
  });
  it('replays results, conflicts changed bodies and cancels a request before late arrival', async () => {
    await seed();
    const a = await login('C01'),
      b = await login('C02');
    const first = await action('/player/nickname', a, { nickname: '测试文明' }, 'same');
    expect((await action('/player/nickname', a, { nickname: '测试文明' }, 'same')).body).toEqual(
      first.body,
    );
    expect((await action('/player/nickname', a, { nickname: '另一文明' }, 'same')).status).toBe(
      409,
    );
    expect((await call('/operations/same', undefined, b)).body).toMatchObject({
      code: 'UNCONFIRMED',
      status: 'pending',
    });
    expect((await call('/operations/late/resolve', {}, a)).body).toMatchObject({
      code: 'CANCELLED',
      status: 'complete',
    });
    expect(
      (await action('/action/homeworld-submit', a, { code: '001234' }, 'late')).body,
    ).toMatchObject({ code: 'CANCELLED' });
    expect((await call('/player/self', undefined, a)).body).toMatchObject({ homeworld: null });
  });
  it('HTTP boundary rejects cross-origin, CSRF, oversized JSON, and serves JSON 404', async () => {
    await seed();
    // This fixture exercises the legacy deployment; platform routing has its own tests.
    const env = {
      APP_ENV: bindings.APP_ENV,
      MATCH_ID: bindings.MATCH_ID,
      MATCH_DO: bindings.MATCH_DO,
      TRUSTED_ORIGINS: 'https://game.test',
    };
    const rejected = await gateway(
      new Request('https://game.test/api/auth/exchange', {
        method: 'POST',
        headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(rejected.status).toBe(403);
    const response = await gateway(
      new Request('https://game.test/api/auth/exchange', {
        method: 'POST',
        headers: { Origin: 'https://game.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: password('C01'), audience: 'player' }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const denied = await gateway(
      new Request('https://game.test/api/player/nickname', {
        method: 'POST',
        headers: {
          Origin: 'https://game.test',
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ request_id: 'x', nickname: '测试文明' }),
      }),
      env,
    );
    expect(denied.status).toBe(403);
    const missing = await gateway(
      new Request('https://game.test/api/no-such-route', { headers: { Cookie: cookie } }),
      env,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
  });
  it('updates parameters only before T0, requires head authority, and invalidates stale previews', async () => {
    await seed();
    const head = await login('J01'),
      communications = await login('J02');
    const parameters = (await call('/judge/parameters', undefined, head)).body as {
      version: number;
      values: Record<string, number>;
    };
    const payload = {
      values: { ...parameters.values, singerPercent: 10 },
      expected_version: parameters.version,
    };
    expect((await manage('/judge/parameters', head, payload)).status).toBe(200);
    expect((await call('/judge/parameters', undefined, head)).body).toMatchObject({
      values: { singerPercent: 10 },
    });
    expect(
      (
        await action('/judge/manage/preview', communications, {
          path: '/judge/parameters',
          ...payload,
          reason: '测试',
          expected_revision: 1,
        })
      ).status,
    ).toBe(403);
  });
  it('runs the full first-launch flow with two players, locks settings, generates no technology events', async () => {
    const { players, head, arms } = await start(2);
    expect(new Set(arms.map((a) => JSON.stringify(a))).size).toBe(2);
    for (const p of players)
      expect((await call('/player/self', undefined, p)).body).toMatchObject({ flight: 'active' });
    const params = (await call('/judge/parameters', undefined, head)).body as {
      version: number;
      values: Record<string, number>;
    };
    expect(
      (
        await action('/judge/manage/preview', head, {
          path: '/judge/parameters',
          values: params.values,
          expected_version: params.version,
          expected_revision: (await call('/public/match')).body && 1,
          reason: '测试',
        })
      ).status,
    ).not.toBe(200);
    await runInDurableObject(stub(), (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM scheduled_events WHERE kind='tech_burst'").toArray(),
      ).toHaveLength(0);
      expect(
        state.storage.sql.exec("SELECT * FROM sighting_codes WHERE status='active'").toArray(),
      ).toHaveLength(2);
    });
  });
  it('separates preregistered accounts from N and the formal roster', async () => {
    const { players, head } = await start(2, 8);
    const spare = await login('C08');
    expect((await action('/action/preflight-issue-code', spare)).status).toBe(409);
    expect((await call('/player/self', undefined, spare)).body).toMatchObject({
      flight: 'absent',
      actions: [],
    });
    expect((await call('/public/match')).body).toMatchObject({ total: 2, survivors: 2 });
    expect(
      (
        await action('/judge/manage/preview', head, {
          path: '/judge/roster',
          members: ['C01', 'C02', 'C08'],
          reason: '测试',
          expected_revision: ((await call('/public/match')).body as { revision: number }).revision,
        })
      ).status,
    ).toBe(409);
    await action('/action/withdraw', players[0]!);
    expect((await call('/results/overview', undefined, spare)).status).toBe(403);
    const report = (await call('/results/overview', undefined, players[1]!)).body as {
      standings: unknown[];
    };
    expect(report.standings).toHaveLength(2);
  });
  it('supports 24 concurrent first-launch accounts and the formula gives eight technology events', async () => {
    await start(24);
    await runInDurableObject(stub(), (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM scheduled_events WHERE kind='tech_burst'").toArray(),
      ).toHaveLength(8);
      expect(
        state.storage.sql.exec('SELECT DISTINCT mac FROM sighting_codes').toArray(),
      ).toHaveLength(24);
    });
  });
  it('allows only one concurrent hit, grants private intelligence, permits fixed-deadline respawn', async () => {
    const { players, arms, startUtc } = await start();
    const target = arms[2]!;
    const shots = await Promise.all([
      action('/action/sighting', players[0]!, { arm_a: target[0], arm_b: target[1] }),
      action('/action/sighting', players[1]!, { arm_a: target[0], arm_b: target[1] }),
    ]);
    expect(shots.map((r) => r.status)).toEqual([200, 200]);
    const outcomes = shots.map(
      (r) => (r.body as { outcome: { target?: string; wrongCount: number } }).outcome,
    );
    expect(outcomes.filter((r) => r.target === 'C03')).toHaveLength(1);
    expect(outcomes.every((r) => r.wrongCount === 0)).toBe(true);
    const victim = players[2]!;
    expect((await call('/player/self', undefined, victim)).body).toMatchObject({
      flight: 'returning',
      respawnDeadline: 900000,
    });
    expect((await call('/public/match')).body).toMatchObject({ survivors: 3, stage: 'forest' });
    testUtc = startUtc + 5000;
    expect((await action('/action/return-confirm', victim)).status).toBe(200);
    expect((await action('/action/issue-code', victim)).status).toBe(200);
    expect((await action('/action/launch', victim)).status).toBe(200);
    expect((await call('/player/self', undefined, victim)).body).toMatchObject({
      flight: 'active',
      flightNumber: 2,
      respawnDeadline: null,
    });
    const snapshot = (await call('/snapshot?route=/player', undefined, players[0]!))
      .body as Snapshot;
    expect(snapshot.civilizations).toEqual([]);
    expect(snapshot.judge).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('ciphertext');
  });
  it('settles a delayed 98-minute cutoff at the correct UTC, stops the clock and batches zero survivors', async () => {
    const { head, players, startUtc } = await start();
    testUtc = startUtc + 8_000_000;
    const match = (await call('/public/match')).body;
    expect(match).toMatchObject({
      phase: 'hunt',
      gameMs: 5880000,
      paused: true,
      verification: true,
    });
    expect(
      (
        await action('/judge/manage/preview', head, {
          path: '/judge/resume',
          reason: '测试',
          expected_revision: (match as { revision: number }).revision,
        })
      ).status,
    ).toBe(409);
    const end = await manage('/judge/hunt-finalize', head, {
      eliminations: players.map((_, i) => ({ id: `C0${i + 1}`, reason: 'no_share_at_cutoff' })),
    });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect((await call('/public/match')).body).toMatchObject({
      stage: 'ended',
      gameMs: 5880000,
      survivors: 0,
    });
    const report = (await call('/results/overview', undefined, players[0]!)).body as {
      champions: string[];
      standings: { rank: number; tied: boolean }[];
    };
    expect(report.champions).toEqual([]);
    expect(report.standings.every((p) => p.rank === 1 && p.tied)).toBe(true);
    await runInDurableObject(stub(), (_instance, state) => {
      const rows = state.storage.sql
        .exec('SELECT utc_ms,game_ms FROM eliminations WHERE valid=1')
        .toArray();
      expect(rows.every((r) => r.utc_ms === startUtc + 5880000 && r.game_ms === 5880000)).toBe(
        true,
      );
    });
  });
  it('rejects extra sighting fields before counting and keeps penalty draws idempotent', async () => {
    const { players, startUtc } = await start();
    const p = players[0]!;
    const unused = await runInDurableObject(stub(), async (_instance, state) => {
      const engine = new Engine(new Store(state.storage), bindings);
      const keys = await engine.keys();
      const used = new Set(
        state.storage.sql
          .exec('SELECT mac FROM sighting_codes')
          .toArray()
          .map((r) => r.mac),
      );
      state.storage.sql.exec(
        "UPDATE settings SET value=json_set(value,'$.secondOutPercent',0) WHERE key='parameters'",
      );
      return decodeArms(keys.codes.find((c) => !used.has(c.mac))!.key);
    });
    const payload = { arm_a: unused[0], arm_b: unused[1] };
    expect((await action('/action/sighting', p, { ...payload, target: 'C02' })).status).toBe(400);
    const first = await action('/action/sighting', p, payload, 'wrong-1');
    expect(first.body).toMatchObject({
      outcome: { wrongCount: 1, lockedUntilUtcMs: startUtc + 300000, eliminated: false },
    });
    expect((await action('/action/sighting', p, payload, 'wrong-1')).body).toEqual(first.body);
    expect((await action('/action/sighting', p, payload)).status).toBe(409);
    testUtc = startUtc + 300001;
    const second = await action('/action/sighting', p, payload, 'wrong-2');
    expect(second.body).toMatchObject({
      outcome: { wrongCount: 2, lockedUntilUtcMs: testUtc + 900000, eliminated: false },
    });
    expect((await action('/action/sighting', p, payload, 'wrong-2')).body).toEqual(second.body);
    testUtc += 900001;
    expect((await action('/action/sighting', p, payload)).body).toMatchObject({
      outcome: { wrongCount: 3, eliminated: true },
    });
    await runInDurableObject(stub(), (_instance, state) => {
      const rows = state.storage.sql
        .exec('SELECT wrong_index,roll FROM attacks WHERE actor=? ORDER BY committed_utc', 'C01')
        .toArray();
      expect(rows).toHaveLength(3);
      expect(rows[0]!.roll).toBeNull();
      expect(rows[1]!.roll).toBeTypeOf('number');
      expect(rows[2]!.roll).toBeNull();
      expect(
        state.storage.sql.exec("SELECT destroyed_game FROM homeworlds WHERE player_id='C01'").one()
          .destroyed_game,
      ).not.toBeNull();
    });
  });
  it('continues accepting after the 120th sighting and creates one review notice', async () => {
    const { players, arms } = await start();
    const p = players[0]!;
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE attack_controls SET attempts=120 WHERE player_id='C01'");
    });
    const own = { arm_a: arms[0]![0], arm_b: arms[0]![1] };
    expect((await action('/action/sighting', p, own)).status).toBe(200);
    testUtc! += 4001;
    expect((await action('/action/sighting', p, own)).status).toBe(200);
    await runInDurableObject(stub(), (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT * FROM notice_queue WHERE dedup_key LIKE 'sighting-threshold:%'")
          .toArray(),
      ).toHaveLength(1);
    });
  });
  it('never reissues any of the 350 historical codes and encrypts recoverable configurations', async () => {
    await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const engine = new Engine(new Store(state.storage), bindings),
        db = engine.db;
      const candidates = await engine.prepareCode(),
        keys = await engine.keys();
      for (let i = 0; i < 350; i++)
        db.tx(() => {
          engine.issue('C01', `issue-${i}`, candidates);
          retire(engine, 'C01', 'test', i, Date.now());
        });
      expect(db.all('SELECT DISTINCT mac FROM sighting_codes')).toHaveLength(350);
      expect(() => db.tx(() => engine.issue('C01', 'overflow', candidates))).toThrow(
        '本场手环配置已耗尽',
      );
      const row = db.one<{ id: string; ciphertext: string; mac: string }>(
        'SELECT id,ciphertext,mac FROM sighting_codes LIMIT 1',
      )!;
      const key = await decrypt(keys.encryption, row.ciphertext, `integration|${row.id}`);
      expect(keys.codes.find((c) => c.key === key)!.mac).toBe(row.mac);
      await expect(decrypt(keys.encryption, row.ciphertext, 'different-match')).rejects.toThrow();
    });
  });
  it('runs the actual alarm without a browser request and remains idempotent', async () => {
    await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const due = Date.now() - 1000;
      state.storage.sql.exec("UPDATE matches SET phase='armed',release_at=?", due);
      state.storage.sql.exec(
        "INSERT INTO scheduled_events(id,kind,clock,due,priority,payload) VALUES('code_release','code_release','utc',?,0,'{}')",
        due,
      );
      await state.storage.setAlarm(Date.now() + 60000);
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    await runInDurableObject(stub(), (_instance, state) => {
      expect(state.storage.sql.exec('SELECT phase FROM matches').one().phase).toBe('outfitting');
      expect(
        state.storage.sql.exec("SELECT * FROM event_log WHERE id='code_release'").toArray(),
      ).toHaveLength(1);
    });
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });
  it('keeps normal players, waiting observers and the display isolated from judge material', async () => {
    const { players, head, startUtc } = await start();
    await action('/action/withdraw', players[0]!);
    expect((await call('/snapshot?route=/observer', undefined, players[0]!)).status).toBe(403);
    testUtc = startUtc + 180000;
    const observer = (await call('/snapshot?route=/observer', undefined, players[0]!))
      .body as Snapshot;
    expect(observer.civilizations).toHaveLength(3);
    expect(observer.judge).toBeNull();
    expect((await action('/action/broadcast', players[0]!, { code: '123456' })).status).toBe(409);
    const display = (await call('/snapshot?route=/display', undefined, head)).body as Snapshot;
    expect(display.judge).toBeNull();
    expect(JSON.stringify(display)).not.toContain('credential_hash');
    expect(JSON.stringify(display)).not.toContain('song_due');
    expect(
      (await manage('/judge/observer-access', head, { target: 'C01', allowed: false })).status,
    ).toBe(200);
    expect((await call('/snapshot?route=/observer', undefined, players[0]!)).status).toBe(403);
  });
  it('uses the same authority and preview checks for GUI and command requests', async () => {
    const { head, players } = await start();
    expect(
      (await action('/judge/command/execute', head, { command: '/inspect C01', reason: '' }))
        .status,
    ).toBe(200);
    const revision = ((await call('/public/match')).body as { revision: number }).revision;
    const preview = await action('/judge/command/preview', head, {
      command: '/clock pause',
      reason: '现场检查',
      expected_revision: revision,
    });
    expect(preview.status).toBe(200);
    expect(
      (
        await action('/judge/command/execute', head, {
          command: '/clock pause',
          reason: '现场检查',
          expected_revision: revision,
          preview_token: (preview.body as { preview: { token: string } }).preview.token,
        })
      ).status,
    ).toBe(200);
    expect((await call('/public/match')).body).toMatchObject({ paused: true });
    expect(
      (
        await action('/judge/command/execute', players[0]!, {
          command: '/clock resume',
          reason: '越权',
        })
      ).status,
    ).toBe(403);
  });
  it('corrects a specific hit without reusing the exposed code or deleting intelligence', async () => {
    const { head, players, arms } = await start();
    const target = arms[1]!;
    expect(
      (
        await action(
          '/action/sighting',
          players[0]!,
          { arm_a: target[0], arm_b: target[1] },
          'correct-me',
        )
      ).status,
    ).toBe(200);
    expect((await manage('/judge/pause', head)).status).toBe(200);
    const corrected = await manage('/judge/attack-correction', head, {
      attack_id: 'action:C01:correct-me:attack',
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    const me = (await call('/player/self', undefined, players[0]!)).body as { kills: number };
    expect(me.kills).toBe(0);
    const victim = (await call('/player/self', undefined, players[1]!)).body as {
      flight: string;
      arms: Arms;
      observerAllowed: boolean;
    };
    expect(victim.flight).toBe('issued');
    expect(victim.arms).not.toEqual(target);
    expect(victim.observerAllowed).toBe(false);
    expect(
      (await manage('/judge/equipment-correction', head, { target: 'C02', mode: 'activate' }))
        .status,
    ).toBe(200);
    expect((await manage('/judge/resume', head)).status).toBe(200);
    expect((await call('/player/self', undefined, players[1]!)).body).toMatchObject({
      flight: 'active',
    });
    const intel = (await call('/player/intel', undefined, players[0]!)).body as unknown[];
    expect(intel).toHaveLength(1);
  });
  it('retains all broadcast and photon privacy rules with configurable singer probability', async () => {
    const { players } = await start();
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE settings SET value=json_set(value,'$.singerPercent',100) WHERE key='parameters'",
      );
      state.storage.sql.exec("UPDATE players SET tech=1,photons=1 WHERE id='C01'");
    });
    const broadcast = await action(
      '/action/broadcast',
      players[0]!,
      { code: '000002' },
      'broadcast',
    );
    expect(broadcast.status).toBe(200);
    expect(broadcast.body).toMatchObject({ outcome: { accepted: true, remaining: 1 } });
    expect(JSON.stringify(broadcast.body)).not.toContain('matched');
    expect(JSON.stringify(broadcast.body)).not.toContain('song');
    expect((await action('/action/broadcast', players[1]!, { code: '000002' })).status).toBe(409);
    expect((await call('/player/intel', undefined, players[1]!)).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ civilization: 'C01', code: '000001' })]),
    );
    const shot = await action('/action/photon', players[0]!, { code: '999999' });
    expect(shot.body).toMatchObject({ outcome: { remaining: 0 } });
    const other = (await call('/snapshot?route=/player', undefined, players[1]!)).body as Snapshot;
    expect(
      other.events.filter((a) => a.kind === 'photon').every((a) => a.actor === undefined),
    ).toBe(true);
    testUtc! += 60000;
    expect((await call('/player/self', undefined, players[1]!)).body).toMatchObject({
      homeAlive: false,
      flight: 'active',
    });
  });
  it('rolls back a hit if the notification write fails halfway through the transaction', async () => {
    const { players, arms } = await start();
    const target = arms[1]!;
    const reply = await runInDurableObject(stub(), async (_instance, state) => {
      const e = new Engine(new Store(state.storage), bindings);
      e.now = () => testUtc!;
      e.notice = () => {
        throw new Error('injected notification storage failure');
      };
      return e.call({
        method: 'POST',
        path: '/action/sighting',
        body: { request_id: 'rollback', arm_a: target[0], arm_b: target[1] },
        token: players[0]!.token,
        csrf: players[0]!.csrf,
        clientKey: 'test',
        edgeUtc: testUtc!,
      });
    });
    expect(reply.status).toBe(503);
    expect((await call('/player/self', undefined, players[1]!)).body).toMatchObject({
      flight: 'active',
    });
    expect((await call('/operations/rollback', undefined, players[0]!)).body).toMatchObject({
      status: 'pending',
    });
    expect(
      (
        await action(
          '/action/sighting',
          players[0]!,
          { arm_a: target[0], arm_b: target[1] },
          'rollback',
        )
      ).status,
    ).toBe(200);
  });
  it('freezes game deadlines during a pause while UTC penalties continue', async () => {
    const { head, players, startUtc } = await start();
    testUtc = startUtc + 10000;
    expect((await manage('/judge/pause', head)).status).toBe(200);
    testUtc += 600000;
    expect((await call('/public/match')).body).toMatchObject({ gameMs: 10000, paused: true });
    expect((await action('/action/broadcast', players[0]!, { code: '123456' })).status).toBe(409);
    expect((await manage('/judge/resume', head)).status).toBe(200);
    testUtc += 1000;
    expect((await call('/public/match')).body).toMatchObject({ gameMs: 11000, paused: false });
  });
  it('finishes at 120 effective minutes after the 98-minute review pause and preserves tied champions', async () => {
    const { head, players, startUtc } = await start();
    testUtc = startUtc + 5880000;
    expect((await call('/public/match')).body).toMatchObject({
      gameMs: 5880000,
      verification: true,
    });
    testUtc += 120000;
    expect((await manage('/judge/hunt-finalize', head, { eliminations: [] })).status).toBe(200);
    testUtc = startUtc + 7200000 + 120000;
    expect((await call('/public/match')).body).toMatchObject({
      gameMs: 7200000,
      stage: 'ended',
      survivors: 3,
    });
    const report = (await call('/results/overview', undefined, players[0]!)).body as {
      champions: string[];
      standings: { flight: string; rank: number; tied: boolean; voyages: unknown[] }[];
    };
    expect(report.champions).toEqual(['C01', 'C02', 'C03']);
    expect(
      report.standings.every(
        (p) => p.flight === 'active' && p.rank === 1 && p.tied && p.voyages.length === 1,
      ),
    ).toBe(true);
    expect(
      (await action('/action/sighting', players[0]!, { arm_a: ['BK', 'WH'], arm_b: ['GY'] }))
        .status,
    ).toBe(409);
  });
  it('paginates using stable positions and rechecks authorization on every page', async () => {
    const { head, players } = await start();
    await runInDurableObject(stub(), (_instance, state) => {
      for (let i = 0; i < 510; i++)
        state.storage.sql.exec(
          "INSERT INTO event_log(id,kind,title,body,audience,owner,civilization_ids,game_ms,utc_ms,committed_utc) VALUES(?,'notice','消息','正文','personal','C01','[]',0,?,?)",
          `page-${i}`,
          Date.now(),
          Date.now(),
        );
    });
    const first = (await call('/snapshot?route=/player', undefined, players[0]!)).body as Snapshot;
    expect(first.events).toHaveLength(500);
    expect(first.eventCursor).toBeTypeOf('string');
    const page = (
      await call(
        `/timeline?route=/player&before=${first.eventCursor}&limit=100`,
        undefined,
        players[0]!,
      )
    ).body as { items: { id: string }[]; nextCursor: string | null };
    const ids = new Set(first.events.map((e) => e.id));
    expect(page.items.every((e) => !ids.has(e.id))).toBe(true);
    expect(page.items.length).toBeGreaterThanOrEqual(10);
    const other = (
      await call(`/timeline?route=/player&before=${first.eventCursor}`, undefined, players[1]!)
    ).body as { items: { id: string }[] };
    expect(other.items.some((e) => e.id.startsWith('page-'))).toBe(false);
    expect(
      (await call(`/timeline?route=/judge&before=${first.eventCursor}`, undefined, players[0]!))
        .status,
    ).toBe(403);
    expect(
      (await call(`/timeline?route=/judge&before=${first.eventCursor}`, undefined, head)).status,
    ).toBe(200);
  });
  it('exports an encrypted full backup to the head judge and excludes authentication from public reports', async () => {
    const { head, players } = await start();
    expect((await call('/judge/export?kind=backup', undefined, head)).status).toBe(409);
    expect((await manage('/judge/pause', head)).status).toBe(200);
    const reply = await call('/judge/export?kind=backup', undefined, head);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const envelope = JSON.parse((reply.body as { text: string }).text) as {
      createdUtc: number;
      ciphertext: string;
      format: string;
    };
    expect(envelope.format).toBe('darkforest-backup-v1');
    expect(JSON.stringify(reply.body)).not.toContain('credential_hash');
    await runInDurableObject(stub(), async (_instance, state) => {
      const e = new Engine(new Store(state.storage), bindings),
        keys = await e.keys();
      const decoded = JSON.parse(
        await decrypt(
          keys.encryption,
          envelope.ciphertext,
          `backup|integration|${envelope.createdUtc}`,
        ),
      ) as { accounts: unknown[]; sighting_codes: unknown[] };
      expect(decoded.accounts).toHaveLength(6);
      expect(decoded.sighting_codes).toHaveLength(3);
    });
    expect((await call('/judge/export?kind=backup', undefined, players[0]!)).status).toBe(403);
  });
  it('delivers a delayed announcement once and replays public text without repeating effects', async () => {
    const { head, players } = await start();
    const match = (await call('/public/match')).body as { revision: number };
    const preview = await action('/judge/command/preview', head, {
      command: '/schedule create utc in 10s run { announce @a "请联系裁判" }',
      reason: '测试通知',
      expected_revision: match.revision,
    });
    expect(preview.status).toBe(200);
    expect(
      (
        await action('/judge/command/execute', head, {
          command: '/schedule create utc in 10s run { announce @a "请联系裁判" }',
          reason: '测试通知',
          expected_revision: match.revision,
          preview_token: (preview.body as { preview: { token: string } }).preview.token,
        })
      ).status,
    ).toBe(200);
    testUtc! += 10001;
    const snapshot = (await call('/snapshot?route=/player', undefined, players[0]!))
      .body as Snapshot;
    expect(snapshot.events.filter((e) => e.body === '请联系裁判')).toHaveLength(1);
    expect((await manage('/judge/replay', head, { count: 1 })).status).toBe(200);
    expect(
      (
        (await call('/snapshot?route=/player', undefined, players[0]!)).body as Snapshot
      ).events.filter((e) => e.body === '请联系裁判'),
    ).toHaveLength(1);
  });
  it('reports Alarm registration failures after a committed action and repairs them later', async () => {
    const { players } = await start();
    const reply = await runInDurableObject(stub(), async (_instance, state) => {
      const e = new Engine(new Store(state.storage), bindings);
      e.now = () => testUtc!;
      const original = state.storage.setAlarm.bind(state.storage);
      state.storage.setAlarm = () =>
        Promise.reject(new Error('injected alarm registration failure'));
      try {
        return await e.call({
          method: 'POST',
          path: '/action/broadcast',
          body: { request_id: 'alarm-failure', code: '999999' },
          token: players[0]!.token,
          csrf: players[0]!.csrf,
          edgeUtc: testUtc!,
          clientKey: 'test',
        });
      } finally {
        state.storage.setAlarm = original;
      }
    });
    expect(reply.status).toBe(200);
    await runInDurableObject(stub(), (_instance, state) => {
      expect(state.storage.sql.exec('SELECT error FROM scheduler_health').one().error).toContain(
        '登记失败',
      );
      expect(
        state.storage.sql.exec("SELECT * FROM broadcasts WHERE code='999999'").toArray(),
      ).toHaveLength(1);
    });
    expect(
      (await action('/action/broadcast', players[0]!, { code: '999999' }, 'alarm-failure')).body,
    ).toEqual(reply.body);
    await call('/public/match');
    await runInDurableObject(stub(), (_instance, state) => {
      expect(state.storage.sql.exec('SELECT error FROM scheduler_health').one().error).toBe('');
    });
  });
});
