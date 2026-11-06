import {
  parseJson,
  jsonObject,
  jsonArray,
  jsonObjects,
  jsonString,
} from '../helpers/json';
import {beforeEach, expect, it} from 'vitest';
import {env} from 'cloudflare:workers';
import {reset, runInDurableObject} from 'cloudflare:test';
import type {BackendEnv, RpcInput} from '../../apps/match-worker/src/rpc/types';
import {Engine} from '../../apps/match-worker/src/services/engine';
import {Store} from '../../apps/match-worker/src/storage/store';
import {
  digest,
  decrypt,
  encrypt,
  secretKey,
} from '../../apps/match-worker/src/security/crypto';
import {
  eliminate,
  finish,
  retire,
} from '../../apps/match-worker/src/services/life';
import {rearm} from '../../apps/match-worker/src/scheduler/events';
import {migrate} from '../../apps/match-worker/src/storage/schema';
import {SCHEMA_VERSION} from '../../apps/match-worker/src/storage/schema';
import {
  capture,
  createCheckpoint,
  openCheckpoint,
  openCarry,
  prepareRecovery,
  restoreCheckpointTables,
  completeRecovery,
} from '../../apps/match-worker/src/services/recovery';

const bindings: BackendEnv = env;
const stub = () => bindings.MATCH_DO.getByName('match:integration');
it('encrypts and authenticates backup payloads larger than one megabyte', async () => {
  const key = await secretKey(btoa('k'.repeat(32)), 'AES-GCM');
  const value = '备份正文'.repeat(100000);
  const sealed = await encrypt(key, value, 'large-backup');
  expect(await decrypt(key, sealed, 'large-backup')).toBe(value);
  await expect(decrypt(key, sealed, 'different-backup')).rejects.toThrow();
});
interface Login {
  token: string;
  csrf: string;
}
let seq = 0;
async function call(path: string, body?: unknown, login?: Login) {
  const input: RpcInput = {
    method: body === undefined ? 'GET' : 'POST',
    path,
    clientKey: 'maintenance',
    edgeUtc: Date.now(),
    ...(body === undefined ? {} : {body}),
    ...(login ? {token: login.token, csrf: login.csrf} : {}),
  };
  const reply = await stub().call(input);
  return {...reply, body: parseJson(reply.body)};
}
async function login(
  id: string,
  credential = `maintenance-password-${id}-long-enough`,
): Promise<Login> {
  const r = await call('/auth/exchange', {
    audience: id.startsWith('J') ? 'judge' : 'player',
    credential,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return {
    token: r.sessionToken!,
    csrf: jsonString(jsonObject(r.body).csrfToken),
  };
}
async function action(
  path: string,
  l: Login,
  body: Record<string, unknown> = {},
  suppliedId?: string,
) {
  const id = suppliedId === undefined ? `m-${++seq}` : suppliedId;
  return call(path, {...body, request_id: id}, l);
}
async function manage(
  path: string,
  l: Login,
  body: Record<string, unknown> = {},
) {
  const state = await call('/public/match');
  const p = await action('/judge/manage/preview', l, {
    path,
    ...body,
    reason: '维护验收',
    expected_revision: jsonObject(state.body).revision,
  });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return action(path, l, {
    ...body,
    reason: '维护验收',
    expected_revision: jsonObject(jsonObject(p.body).preview).revision,
    preview_token: jsonObject(jsonObject(p.body).preview).token,
  });
}
beforeEach(async () => {
  await reset();
  seq = 0;
  const accounts = await Promise.all(
    [
      {id: 'C01', role: 'player', name: '玩家一'},
      {id: 'C02', role: 'player', name: '玩家二'},
      {id: 'J01', role: 'judge', name: '总裁判', duty: 'head'},
      {id: 'J02', role: 'judge', name: '通讯裁判', duty: 'communications'},
      {id: 'J03', role: 'judge', name: '事件裁判', duty: 'events'},
    ].map(async a => ({
      ...a,
      credential_hash: await digest(`maintenance-password-${a.id}-long-enough`),
    })),
  );
  const r = await stub().bootstrap('integration-only-bootstrap-secret', {
    match_id: 'integration',
    accounts,
  });
  expect(r.status).toBe(201);
});
it('validates recovery file metadata without changing the valid encrypted format', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const engine = new Engine(new Store(state.storage), bindings);
    const checkpoint = await createCheckpoint(engine);
    const opened = await openCheckpoint(engine, checkpoint);
    expect(opened.envelope).toEqual(checkpoint);
    await expect(
      openCheckpoint(engine, {...checkpoint, revision: '1'}),
    ).rejects.toThrow();
    await expect(
      openCheckpoint(engine, {...checkpoint, bookmark: null}),
    ).rejects.toThrow();
    const carry = await prepareRecovery(engine, {
      target: checkpoint,
      reason: '验证恢复文件元数据',
    });
    expect((await openCarry(engine, carry)).envelope).toEqual(carry);
    await expect(
      openCarry(engine, {...carry, createdUtc: String(carry.createdUtc)}),
    ).rejects.toThrow();
    await expect(
      openCarry(engine, {...carry, id: {value: carry.id}}),
    ).rejects.toThrow();
  });
});
it('upgrades an existing v5 database without losing notices and applies the upgrade only once', async () => {
  await runInDurableObject(stub(), (_instance, state) => {
    const db = new Store(state.storage);
    db.exec(
      "INSERT INTO notice_queue(id,dedup_key,channel,target,title,body,game_ms,ordering_seq) VALUES('legacy-notice','legacy','private','C01','飞船被击毁','待发送',100,1)",
    );
    db.exec('DROP TABLE notice_actions');
    db.exec('DROP TABLE judge_eliminations');
    db.exec('DROP INDEX notice_pending');
    for (const column of [
      'copied_by',
      'copied_utc',
      'sent_by',
      'sent_utc',
      'priority',
    ]) {
      db.exec(`ALTER TABLE notice_queue DROP COLUMN ${column}`);
    }
    for (const column of [
      'attempt_count',
      'last_attempt_utc',
      'last_error',
      'last_error_utc',
    ]) {
      db.exec(`ALTER TABLE scheduled_events DROP COLUMN ${column}`);
    }
    db.exec('ALTER TABLE audit_logs DROP COLUMN game_ms');
    db.exec('ALTER TABLE previews DROP COLUMN impact');
    db.exec('DROP TABLE judge_command_log');
    db.exec('DROP TABLE command_tags');
    db.exec('DROP TABLE command_objects');
    for (const table of [
      'match_identity',
      'memberships',
      'staff_assignments',
      'authorization_fences',
      'control_operations',
      'match_outbox',
      'audit_identities',
      'participation_history',
    ]) {
      db.exec(`DROP TABLE ${table}`);
    }
    db.exec('DELETE FROM schema_meta WHERE version>=6');
    migrate(state.storage);
    migrate(state.storage);
    expect(
      db.one<Record<string, SqlStorageValue>>(
        'SELECT status,priority,copied_by,sent_by FROM notice_queue WHERE id=?',
        'legacy-notice',
      ),
    ).toEqual({
      status: 'pending',
      priority: 90,
      copied_by: null,
      sent_by: null,
    });
    expect(
      db.one<Record<string, SqlStorageValue>>(
        'SELECT MAX(version) AS version FROM schema_meta',
      ),
    ).toEqual({
      version: SCHEMA_VERSION,
    });
    expect(
      db.one<Record<string, SqlStorageValue>>(
        'SELECT COUNT(*) AS count FROM accounts',
      ),
    ).toEqual({
      count: 5,
    });
  });
});

it('preserves copy/send history across a short local checkpoint recovery', async () => {
  const communications = await login('J02');
  const events = await login('J03');
  const noticeId = await runInDurableObject(stub(), (_instance, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    e.notice('recovery-notice', 'C01', '飞船被击毁', '保全履历');
    return e.db.one<{id: string}>('SELECT id FROM notice_queue')!.id;
  });
  const checkpoint = await runInDurableObject(stub(), (_instance, state) =>
    createCheckpoint(new Engine(new Store(state.storage), bindings)),
  );
  expect(
    (
      await action(`/judge/notices/${noticeId}/copied`, communications, {
        expected_version: 1,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await action(`/judge/notices/${noticeId}/sent`, events, {
        expected_version: 2,
      })
    ).status,
  ).toBe(200);
  await runInDurableObject(stub(), async (_instance, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    const carry = await prepareRecovery(e, {
      target: checkpoint,
      reason: '短时通知保全回归',
    });
    const target = await openCheckpoint(e, checkpoint);
    restoreCheckpointTables(e, target.tables);
    await completeRecovery(e, carry);
    expect(
      e.db.one<Record<string, SqlStorageValue>>(
        'SELECT status,copied_by,sent_by FROM notice_queue WHERE id=?',
        noticeId,
      ),
    ).toEqual({status: 'sent', copied_by: '通讯裁判', sent_by: '事件裁判'});
    expect(
      e.db.all<Record<string, SqlStorageValue>>(
        'SELECT actor,action FROM notice_actions WHERE notice_id=? ORDER BY utc_ms,id',
        noticeId,
      ),
    ).toEqual(
      expect.arrayContaining([
        {actor: 'J02', action: 'copied'},
        {actor: 'J03', action: 'sent'},
      ]),
    );
  });
});
it('revokes sessions and old credentials, recovers the same reset result, and restricts delivery', async () => {
  const head = await login('J01');
  const player = await login('C01');
  const communications = await login('J02');
  const summaries = await call('/judge/accounts', undefined, head);
  expect(summaries.status).toBe(200);
  expect(summaries.body).toHaveLength(5);
  expect(JSON.stringify(summaries.body)).not.toContain('credential_hash');
  expect(
    (await call('/judge/accounts', undefined, communications)).status,
  ).toBe(403);
  const result = await manage('/judge/accounts', head, {
    target: 'C01',
    operation: 'reset',
    expected_version: 1,
  });
  expect(result.status).toBe(200);
  const id = jsonString(jsonObject(result.body).credentialDeliveryId);
  expect(id).toBeTypeOf('string');
  expect((await call('/player/self', undefined, player)).status).toBe(401);
  const credential = await call(`/judge/credentials/${id}`, undefined, head);
  expect(credential.status).toBe(200);
  expect(jsonObject(credential.body).credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(
    (await call(`/judge/credentials/${id}`, undefined, communications)).status,
  ).toBe(403);
  expect(
    (
      await call('/auth/exchange', {
        audience: 'player',
        credential: 'maintenance-password-C01-long-enough',
      })
    ).status,
  ).toBe(401);
  const next = await login(
    'C01',
    jsonString(jsonObject(credential.body).credential),
  );
  expect((await call('/player/self', undefined, next)).status).toBe(200);
  await runInDurableObject(stub(), (_i, state) => {
    expect(
      JSON.stringify(
        state.storage.sql
          .exec<Record<string, SqlStorageValue>>(
            'SELECT * FROM request_journal',
          )
          .toArray(),
      ),
    ).not.toContain(jsonObject(credential.body).credential);
    expect(
      JSON.stringify(
        state.storage.sql
          .exec<Record<string, SqlStorageValue>>(
            'SELECT * FROM credential_deliveries',
          )
          .toArray(),
      ),
    ).not.toContain(jsonObject(credential.body).credential);
  });
  expect(
    (
      await manage('/judge/accounts', head, {
        target: 'C01',
        operation: 'disable',
        expected_version: 2,
      })
    ).status,
  ).toBe(200);
  expect((await call('/player/self', undefined, next)).status).toBe(401);
  expect(
    (
      await manage('/judge/accounts', head, {
        target: 'J02',
        operation: 'duty',
        duty: 'events',
        expected_version: 1,
      })
    ).status,
  ).toBe(200);
  expect((await call('/auth/session', undefined, communications)).status).toBe(
    401,
  );
  const relogged = await login('J02');
  expect(
    (await call('/snapshot?route=/judge/homeworlds', undefined, relogged))
      .status,
  ).toBe(403);
});
it('keeps report versions immutable while corrections recalculate rankings', async () => {
  const head = await login('J01');
  const player = await login('C01');
  await runInDurableObject(stub(), async (_i, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    await e.keys();
    state.storage.sql.exec<Record<string, SqlStorageValue>>(
      "UPDATE players SET nickname=CASE id WHEN 'C01' THEN '文明一' ELSE '文明二' END",
    );
    state.storage.sql.exec<Record<string, SqlStorageValue>>(
      "UPDATE flights SET status='active'",
    );
    state.storage.sql.exec<Record<string, SqlStorageValue>>(
      "UPDATE matches SET phase='forest',started_at=?,start_settled=?",
      Date.now(),
      Date.now(),
    );
    finish(e, 'regulation', 7200000, Date.now(), 'test');
  });
  const first = await call('/results/report?version=1', undefined, player);
  expect(jsonObject(first.body).champions).toEqual(['C01', 'C02']);
  const corrected = await manage('/judge/report-correction', head, {
    field: 'nickname',
    target: 'C01',
    value: '更正文明',
    expected_version: 1,
  });
  expect(corrected.status).toBe(200);
  expect(
    (await call('/results/report?version=1', undefined, player)).body,
  ).toEqual(first.body);
  const second = await call('/results/report?version=2', undefined, player);
  expect(
    jsonObject(jsonArray(jsonObject(second.body).standings)[0]).nickname,
  ).toBe('更正文明');
  expect(jsonObject(second.body).correctionReason).toBe('维护验收');
  expect(
    (
      await action('/judge/manage/preview', head, {
        path: '/judge/report-correction',
        field: 'nickname',
        target: 'C01',
        value: '旧版本',
        expected_version: 1,
        reason: '测试',
        expected_revision: jsonObject((await call('/public/match')).body)
          .revision,
      })
    ).status,
  ).toBe(409);
});
it('recalculates champions and elimination rankings without changing earlier reports', async () => {
  const head = await login('J01');
  await runInDurableObject(stub(), async (_i, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    await e.keys();
    e.db.exec("UPDATE flights SET status='active'");
    e.db.exec(
      "UPDATE matches SET phase='forest',started_at=?,start_settled=?",
      Date.now(),
      Date.now(),
    );
    e.db.exec(
      "INSERT INTO attacks(id,actor,target,request_id,classification,edge_utc,committed_utc,game_ms) VALUES('hit-1','C01','C02','hit-request','hit',1,1,1)",
    );
    finish(e, 'regulation', 7200000, Date.now(), 'rank-test');
  });
  const first = jsonObject(
    (await call('/results/report?version=1', undefined, head)).body,
  );
  expect(first.champions).toEqual(['C01']);
  expect(
    (
      await manage('/judge/report-correction', head, {
        field: 'attack_valid',
        target: 'hit-1',
        value: false,
        expected_version: 1,
      })
    ).status,
  ).toBe(200);
  expect(
    jsonObject((await call('/results/report?version=2', undefined, head)).body)
      .champions,
  ).toEqual(['C01', 'C02']);
  await runInDurableObject(stub(), async (_i, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    await e.keys();
    // Establish the recorded elimination whose validity is being corrected.
    eliminate(
      e,
      'C02',
      'location_violation',
      'recorded-out',
      7000000,
      Date.now(),
    );
  });
  expect(
    (
      await manage('/judge/report-correction', head, {
        field: 'elimination_valid',
        target: 'C02',
        value: true,
        expected_version: 2,
      })
    ).status,
  ).toBe(200);
  const third = jsonObject(
    (await call('/results/report?version=3', undefined, head)).body,
  );
  expect(third.champions).toEqual(['C01']);
  expect(
    jsonObject(jsonObjects(third.standings).find(c => c.id === 'C02')).rank,
  ).toBe(2);
  expect(
    (
      await manage('/judge/report-correction', head, {
        field: 'elimination_valid',
        target: 'C02',
        value: false,
        expected_version: 3,
      })
    ).status,
  ).toBe(200);
  expect(
    jsonObject((await call('/results/report?version=4', undefined, head)).body)
      .champions,
  ).toEqual(['C01', 'C02']);
  expect(
    (await call('/results/report?version=1', undefined, head)).body,
  ).toEqual(first);
  expect(
    (await call('/results/report?version=3', undefined, head)).body,
  ).toEqual(third);
});
it('blocks an already preparing write when recovery starts before its final transaction', async () => {
  const player = await login('C01');
  await runInDurableObject(stub(), async (_i, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    await e.keys();
    e.prepareCode = () => {
      e.db.exec("UPDATE matches SET recovery_state='prepared:race-test'");
      return Promise.resolve([]);
    };
    const result = await e.call({
      method: 'POST',
      path: '/action/issue-code',
      token: player.token,
      csrf: player.csrf,
      body: {request_id: 'late-issue'},
      clientKey: 'race',
      edgeUtc: Date.now(),
    });
    expect(result.status).toBe(503);
    expect(
      e.db.all<Record<string, SqlStorageValue>>('SELECT * FROM sighting_codes'),
    ).toHaveLength(0);
    expect(
      e.db.all<Record<string, SqlStorageValue>>(
        "SELECT * FROM request_journal WHERE request_id='late-issue'",
      ),
    ).toHaveLength(0);
    e.schedule(
      'after-recovery',
      'judge_delayed_command',
      'utc',
      Date.now() + 60000,
      1,
      {
        message: '恢复后通知',
      },
    );
    await rearm(e);
    expect(await state.storage.getAlarm()).toBeNull();
    e.db.exec("UPDATE matches SET recovery_state=''");
    await rearm(e);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});
it('paginates all notice and audit records without duplicates under concurrent inserts', async () => {
  const head = await login('J01');
  const communications = await login('J02');
  const player = await login('C01');
  await runInDurableObject(stub(), (_i, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    for (let i = 0; i < 350; i++) {
      e.notice(`notice-${i}`, 'C01', '赛事通知', String(i));
      e.audit('J01', '测试操作', 'C01', String(i));
    }
  });
  const initial = jsonObject(
    jsonObject((await call('/snapshot?route=/judge', undefined, head)).body)
      .judge,
  );
  expect((await call('/judge/records/notices', undefined, head)).status).toBe(
    200,
  );
  expect(initial.notices).toHaveLength(100);
  const all = new Set(jsonObjects(initial.notices).map(n => n.id));
  let cursor = jsonObject(initial.cursors).notices;
  await runInDurableObject(stub(), (_i, state) =>
    new Engine(new Store(state.storage), bindings).notice(
      'new-notice',
      'C01',
      '新通知',
      '新内容',
    ),
  );
  while (cursor) {
    const page = await call(
      `/judge/records/notices?before=${jsonString(cursor)}`,
      undefined,
      head,
    );
    expect(page.status).toBe(200);
    for (const row of jsonArray(jsonObject(page.body).items)) {
      expect(all.has(jsonString(jsonObject(row).id))).toBe(false);
      all.add(jsonString(jsonObject(row).id));
    }
    cursor = jsonObject(page.body).nextCursor;
  }
  expect(all.size).toBe(350);
  expect(
    (
      await call(
        '/judge/records/audits?before=999999',
        undefined,
        communications,
      )
    ).status,
  ).toBe(403);
  expect(
    (await call('/judge/records/notices?before=999999', undefined, player))
      .status,
  ).toBe(403);
});
it('rolls back every recovery merge when preserved code evidence conflicts with the checkpoint', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const engine = new Engine(new Store(state.storage), bindings);
    await engine.keys();
    engine.issue('C01', 'before-conflict', await engine.prepareCode());
    const checkpoint = await createCheckpoint(engine);
    const target = await openCheckpoint(engine, checkpoint);
    engine.db.exec(
      "UPDATE accounts SET credential_hash='changed-before-recovery',enabled=0,version=version+1 WHERE id='C01'",
    );
    engine.db.exec("UPDATE sighting_codes SET ciphertext='conflicting-code'");
    const carry = await prepareRecovery(engine, {
      target: checkpoint,
      reason: '验证保全冲突时整个合并事务回滚',
    });
    restoreCheckpointTables(engine, target.tables);
    const before = capture(engine);
    await expect(completeRecovery(engine, carry)).rejects.toThrow(
      '历史手环配置存在冲突',
    );
    expect(capture(engine)).toEqual(before);
  });
});

it('restores checkpoint data, preserves every issued code, invalidates late requests and sessions, and reauthenticates evidence', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    await e.keys();
    const prepared = await e.prepareCode();
    e.db.tx(() => {
      e.issue('C01', 'before', prepared);
      e.db.exec("UPDATE flights SET status='outfitting' WHERE player_id='C01'");
    });
    const checkpoint = await createCheckpoint(e);
    const target = await openCheckpoint(e, checkpoint);
    e.db.tx(() => {
      retire(e, 'C01', 'hit', 0, Date.now());
      e.issue('C01', 'after', prepared);
      e.db.exec("UPDATE flights SET status='outfitting' WHERE player_id='C01'");
      e.db.exec(
        "INSERT INTO request_journal VALUES('C01','late','/action/sighting','digest','{}',0)",
      );
      e.db.bump();
    });
    const carry = await prepareRecovery(e, {
      target: checkpoint,
      reason: '独立场次恢复演练',
    });
    await expect(
      openCheckpoint(e, {...checkpoint, bookmark: 'tampered'}),
    ).rejects.toThrow();
    restoreCheckpointTables(e, target.tables);
    const result = await completeRecovery(e, carry);
    expect(result.issuedCount).toBe(2);
    expect(
      e.db.all<Record<string, SqlStorageValue>>(
        'SELECT id FROM sighting_codes',
      ),
    ).toHaveLength(2);
    expect(
      e.db.all<Record<string, SqlStorageValue>>(
        "SELECT id FROM sighting_codes WHERE status!='retired'",
      ),
    ).toHaveLength(0);
    expect(e.db.match().recovery_state).toContain('review:');
    expect(
      e.db.one<{cancelled: number}>(
        "SELECT cancelled FROM request_journal WHERE request_id='late'",
      )!.cancelled,
    ).toBe(1);
    expect(
      e.db.all<Record<string, SqlStorageValue>>(
        'SELECT * FROM sessions WHERE revoked=0',
      ),
    ).toHaveLength(0);
    expect((await completeRecovery(e, carry)).issuedCount).toBe(2);
    const keys = await e.keys();
    const plaintext = await decrypt(
      keys.encryption,
      carry.ciphertext,
      `recovery|integration|${carry.id}|${carry.createdUtc}`,
    );
    expect(
      jsonObject(jsonObject(parseJson(plaintext)).latest).sighting_codes,
    ).toHaveLength(2);
    const reportCount = e.db.all<Record<string, SqlStorageValue>>(
      'SELECT version FROM result_reports',
    ).length;
    expect(reportCount).toBe(0);
  });
});
