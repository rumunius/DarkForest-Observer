import {beforeEach, expect, it} from 'vitest';
import {env} from 'cloudflare:workers';
import {reset, runInDurableObject, evictDurableObject} from 'cloudflare:test';
import type {BackendEnv, RpcInput} from '../../apps/match-worker/src/rpc/types';
import {Engine} from '../../apps/match-worker/src/services/engine';
import {Store} from '../../apps/match-worker/src/storage/store';
import {digest, decrypt} from '../../apps/match-worker/src/security/crypto';
import type {OperationResult} from '@darkforest/contracts';
import {
  createCheckpoint,
  openCheckpoint,
  prepareRecovery,
  restoreCheckpointTables,
  completeRecovery,
  finishRecovery,
} from '../../apps/match-worker/src/services/recovery';
const bindings = env as unknown as BackendEnv;
const stub = () => bindings.MATCH_DO.getByName('match:integration');
let sequence = 0;
let now = Date.now();
interface Login {
  token: string;
  csrf: string;
}
let head: Login;
let communications: Login;
let player: Login;
async function call(path: string, body?: unknown, login?: Login) {
  return runInDurableObject(stub(), async (_instance, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    e.now = () => now;
    return e.call({
      path,
      method: body === undefined ? 'GET' : 'POST',
      clientKey: 'commands',
      edgeUtc: now,
      ...(body === undefined ? {} : {body}),
      ...(login ? {token: login.token, csrf: login.csrf} : {}),
    } satisfies RpcInput);
  });
}
async function login(id: string): Promise<Login> {
  const r = await call('/auth/exchange', {
    credential: `command-test-${id}-credential-long-enough`,
    audience: id.startsWith('J') ? 'judge' : 'player',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return {
    token: r.sessionToken!,
    csrf: (r.body as {csrfToken: string}).csrfToken,
  };
}
async function sql(query: string, ...args: SqlStorageValue[]) {
  return runInDurableObject(stub(), (_instance, state) =>
    new Store(state.storage).all(query, ...args),
  );
}
async function command(text: string, l = head, id = `cmd-${++sequence}`) {
  return call('/judge/command/execute', {request_id: id, command: text}, l);
}
async function plan(text: string) {
  const r = await command(text);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const p = (r.body as OperationResult).preview;
  expect(p).toBeDefined();
  return p!;
}
async function confirm(token: string, id?: string) {
  return command('/confirm ' + token, head, id);
}
async function forest() {
  await sql(
    "UPDATE matches SET phase='forest',started_at=?,start_settled=?",
    now - 600000,
    now - 600000,
  );
  await sql("UPDATE flights SET status='active'");
  await sql("UPDATE homeworlds SET status='verified'");
}
beforeEach(async () => {
  await reset();
  sequence = 0;
  now = Date.now();
  const accounts = await Promise.all(
    [
      ...['C01', 'C02', 'C03', 'C04'].map(id => ({
        id,
        role: 'player',
        name: id,
      })),
      ...['head', 'communications', 'events'].map((duty, i) => ({
        id: `J0${i + 1}`,
        role: 'judge',
        name: duty,
        duty,
      })),
    ].map(async a => ({
      ...a,
      credential_hash: await digest(
        `command-test-${a.id}-credential-long-enough`,
      ),
    })),
  );
  const boot = await stub().bootstrap('integration-only-bootstrap-secret', {
    match_id: 'integration',
    accounts,
  });
  expect(boot.status).toBe(201);
  for (const [i, id] of ['C01', 'C02', 'C03', 'C04'].entries()) {
    await sql(
      "INSERT INTO homeworlds(player_id,code,status,version) VALUES(?,?,'verified',1)",
      id,
      `00000${i}`,
    );
  }
  head = await login('J01');
  communications = await login('J02');
  player = await login('C01');
});
it('rejects players and checks expanded permissions; communications can query and send', async () => {
  expect(
    (await call('/snapshot?route=/judge/commands', undefined, communications))
      .status,
  ).toBe(200);
  expect((await command('/help', player)).status).toBe(403);
  expect((await command('/help', communications)).status).toBe(200);
  expect(
    (await command('/batch run { player eliminate C01 }', communications))
      .status,
  ).toBe(403);
  const p = await command('/tell C01 "请联系裁判"', communications);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  expect((p.body as OperationResult).preview).toBeDefined();
});
it('人工技术爆炸只在执行时产生本人通知，重试不重复且其他玩家不可见', async () => {
  await forest();
  const preview = await plan('/event trigger tech-burst C01');
  expect(await sql("SELECT id FROM event_log WHERE kind='tech'")).toEqual([]);
  expect((await confirm(preview.token, 'notify-tech')).status).toBe(200);
  expect((await confirm(preview.token, 'notify-tech')).status).toBe(200);
  const own = await call('/snapshot?route=/player', undefined, player);
  const events = (own.body as {events: Array<{title: string; body: string}>})
    .events;
  expect(events.filter(event => event.title === '技术爆炸')).toEqual([
    expect.objectContaining({
      body: expect.stringContaining('你的文明刚刚发生了技术爆炸'),
    }),
  ]);
  expect(
    await sql("SELECT target FROM notice_queue WHERE title='技术爆炸'"),
  ).toEqual([{target: 'C01'}]);
  const other = await call(
    '/snapshot?route=/player',
    undefined,
    await login('C02'),
  );
  expect(
    (other.body as {events: Array<{title: string}>}).events.some(
      event => event.title === '技术爆炸',
    ),
  ).toBe(false);
});

function resultData(reply: Awaited<ReturnType<typeof command>>) {
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return JSON.parse((reply.body as OperationResult).message);
}
it('F09 records real command before/after state, encrypted input, preview, reason and linked audit', async () => {
  await forest();
  const p = await plan('/penalty wrong-set C01 2 --reason "复核处罚"');
  const reply = await confirm(p.token, 'audit-confirm');
  expect(reply.status).toBe(200);
  const [row] = await sql(
    "SELECT * FROM judge_command_log WHERE request_id='audit-confirm'",
  );
  const detail = JSON.parse(String(row!.detail));
  expect(detail.reason).toBe('复核处罚');
  expect(detail.preview.token).toBe(p.token);
  expect(detail.targets).toEqual(['C01']);
  expect(
    detail.before.controls.find(
      (p: {player_id: string}) => p.player_id === 'C01',
    ).wrong,
  ).toBe(0);
  expect(
    detail.after.controls.find(
      (p: {player_id: string}) => p.player_id === 'C01',
    ).wrong,
  ).toBe(2);
  expect(detail.result.status).toBe('complete');
  expect(
    await sql('SELECT id FROM audit_logs WHERE id=?', detail.auditId),
  ).toHaveLength(1);
  await runInDurableObject(stub(), async (_instance, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    const keys = await e.keys();
    expect(
      await decrypt(
        keys.encryption,
        String(row!.ciphertext),
        'command|integration|J01|audit-confirm',
      ),
    ).toBe(`/confirm ${p.token}`);
  });
  const history = resultData(
    await command(
      '/command history --target C01 --kind "penalty wrong-set" --status executed --search "复核处罚"',
    ),
  );
  expect(history.items).toHaveLength(1);
  expect(history.items[0].request_id).toBe('audit-confirm');
  expect(history.items[0]).not.toHaveProperty('ciphertext');
  const http = await call(
    '/judge/command/history?target=C01&status=executed&search=' +
      encodeURIComponent('复核处罚'),
    undefined,
    head,
  );
  expect(http.status).toBe(200);
  expect((http.body as {items: unknown[]}).items).toHaveLength(1);
  expect(JSON.stringify(http.body)).not.toContain('ciphertext');
  expect(
    (await call('/judge/command/history', undefined, communications)).status,
  ).toBe(403);
  expect(JSON.stringify(detail)).not.toContain('credential_hash');
  expect(JSON.stringify(detail)).not.toContain('token_hash');
});

it('F09 records request and plan queries, cancellation, rejection and confirmation replay separately', async () => {
  await forest();
  const p = await plan('/photon grant C01');
  await command(`/plan inspect ${p.token}`);
  await command('/request inspect absent-request');
  await command(`/plan cancel ${p.token}`);
  expect((await confirm(p.token)).status).toBe(400);
  const q = await plan('/photon grant C02');
  await confirm(q.token, 'once');
  await confirm(q.token, 'once');
  await confirm(q.token, 'second-confirm');
  const logs = await sql(
    'SELECT path,status,request_id,detail FROM judge_command_log ORDER BY seq',
  );
  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({path: 'plan inspect', status: 'queried'}),
      expect.objectContaining({path: 'request inspect', status: 'queried'}),
      expect.objectContaining({path: 'plan cancel', status: 'cancelled'}),
      expect.objectContaining({path: 'confirm', status: 'rejected'}),
      expect.objectContaining({
        path: 'photon grant',
        status: 'replayed',
        request_id: 'second-confirm',
      }),
    ]),
  );
  expect(logs.filter(r => r.request_id === 'once')).toHaveLength(1);
});

it('F09 retains deferred command outcome, parent, affected targets and before/after audit facts', async () => {
  await forest();
  const p = await plan(
    '/schedule create utc in 1s run { photon grant C01 } --late run',
  );
  expect((await confirm(p.token)).status).toBe(200);
  now += 1001;
  await call('/public/match');
  const [row] = await sql(
    "SELECT detail,ciphertext FROM judge_command_log WHERE path='schedule due' AND status='executed'",
  );
  const detail = JSON.parse(String(row!.detail));
  expect(detail.parent).toMatch(/^SCH-/);
  expect(detail.eventId).toBe(detail.parent);
  expect(detail.targets).toEqual(['C01']);
  expect(
    detail.before.players.find((p: {id: string}) => p.id === 'C01').photons,
  ).toBe(0);
  expect(
    detail.after.players.find((p: {id: string}) => p.id === 'C01').photons,
  ).toBe(1);
  expect(row!.ciphertext).toBeNull();
  expect(
    await sql('SELECT id FROM audit_logs WHERE id=?', detail.auditId),
  ).toHaveLength(1);
});
it('F09 binds encrypted original text to each concurrent request on the same engine', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    const keys = await e.keys();
    e.now = () => now;
    const inputs = ['/whoami', '/help', '/clock status'];
    const replies = await Promise.all(
      inputs.map((command, i) =>
        e.call({
          path: '/judge/command/execute',
          method: 'POST',
          clientKey: 'concurrent-log',
          edgeUtc: now,
          token: head.token,
          csrf: head.csrf,
          body: {request_id: `concurrent-${i}`, command},
        }),
      ),
    );
    expect(replies.map(r => r.status)).toEqual([200, 200, 200]);
    for (const [i, original] of inputs.entries()) {
      const row = e.db.one<{ciphertext: string}>(
        'SELECT ciphertext FROM judge_command_log WHERE request_id=?',
        `concurrent-${i}`,
      )!;
      expect(
        await decrypt(
          keys.encryption,
          row.ciphertext,
          `command|integration|J01|concurrent-${i}`,
        ),
      ).toBe(original);
    }
  });
});

it('F10 reads actual plans and failed diagnostics, distinguishes event facts and rejects cancelled/early retries', async () => {
  await forest();
  await sql(
    "INSERT INTO scheduled_events(id,kind,clock,due,priority,payload,last_error,attempt_count) VALUES('future-tech','tech_burst','game',700000,2,'{}','注入故障',3)",
  );
  const list = resultData(await command('/event list --status failed'));
  expect(list.items).toEqual([
    expect.objectContaining({
      id: 'future-tech',
      last_error: '注入故障',
      attempt_count: 3,
    }),
  ]);
  expect(resultData(await command('/event inspect future-tech')).status).toBe(
    'pending',
  );
  expect(resultData(await command('/event-log list')).items).toEqual([]);
  expect((await command('/event retry future-tech')).status).toBe(400);
  await confirm((await plan('/clock pause')).token);
  await confirm((await plan('/event cancel future-tech')).token);
  expect((await command('/event retry future-tech')).status).toBe(400);
  expect(
    await sql("SELECT status FROM scheduled_events WHERE id='future-tech'"),
  ).toEqual([{status: 'cancelled'}]);
});

it('F10 retries a settled event as a no-op with original facts and does not duplicate random effects', async () => {
  await forest();
  await sql(
    "INSERT INTO scheduled_events(id,kind,clock,due,priority,payload) VALUES('due-tech','tech_burst','game',600000,2,'{}')",
  );
  resultData(await command('/event inspect due-tech'));
  const facts = await sql("SELECT * FROM event_log WHERE id='due-tech'");
  expect(facts).toHaveLength(1);
  const p = await plan('/event retry due-tech');
  const r = resultData(await confirm(p.token));
  expect(r.result.event).toMatchObject({id: 'due-tech', status: 'settled'});
  expect(r.result.outcome.id).toBe('due-tech');
  expect(await sql("SELECT * FROM event_log WHERE id='due-tech'")).toEqual(
    facts,
  );
  expect(await sql('SELECT COUNT(*) n FROM players WHERE tech=1')).toEqual([
    {n: 1},
  ]);
  expect(
    await sql(
      "SELECT status FROM judge_command_log WHERE path='event retry' ORDER BY seq DESC LIMIT 1",
    ),
  ).toEqual([{status: 'no_op'}]);
});
it('F10 creates one independent singer event through the command and preserves existing plans', async () => {
  await forest();
  await sql(
    "INSERT INTO scheduled_events(id,kind,clock,due,priority,payload) VALUES('natural-tech','tech_burst','game',700000,2,'{}')",
  );
  const before = await sql(
    "SELECT * FROM scheduled_events WHERE id='natural-tech'",
  );
  const p = await plan('/event trigger singer 000000');
  expect(
    await sql("SELECT destroyed_game FROM homeworlds WHERE player_id='C01'"),
  ).toEqual([{destroyed_game: null}]);
  const first = await confirm(p.token, 'manual-singer');
  expect(first.status).toBe(200);
  expect((await confirm(p.token, 'manual-singer')).body).toEqual(first.body);
  expect(
    await sql("SELECT COUNT(*) n FROM event_log WHERE kind='singer'"),
  ).toEqual([{n: 1}]);
  expect(
    await sql("SELECT destroyed_game FROM homeworlds WHERE player_id='C01'"),
  ).toEqual([{destroyed_game: 600000}]);
  expect(
    await sql("SELECT * FROM scheduled_events WHERE id='natural-tech'"),
  ).toEqual(before);
});

it('F11 resolves living, dead, filtered and random candidates without including non-roster accounts', async () => {
  await forest();
  await sql("DELETE FROM roster_members WHERE player_id='C04'");
  await sql("UPDATE flights SET status='returning' WHERE player_id='C02'");
  await sql("UPDATE flights SET status='eliminated' WHERE player_id='C03'");
  expect(
    resultData(await command('/selector inspect @alive')).candidates,
  ).toEqual(['C01', 'C02']);
  expect(
    resultData(await command('/selector inspect @dead')).candidates,
  ).toEqual(['C03']);
  expect(
    resultData(await command('/selector inspect @a[status=returning]'))
      .candidates,
  ).toEqual(['C02']);
  expect(
    resultData(await command('/selector inspect @random[alive,sort=id]')),
  ).toMatchObject({
    candidates: ['C01', 'C02'],
    count: 1,
    random: true,
  });
  const p = await plan('/photon grant @random[alive]');
  expect((await confirm(p.token, 'fixed-draw')).status).toBe(200);
  const actual = await sql('SELECT id FROM players WHERE photons=1');
  expect(actual).toHaveLength(1);
  expect((await confirm(p.token, 'fixed-draw')).status).toBe(200);
  expect(await sql('SELECT id FROM players WHERE photons=1')).toEqual(actual);
});

it('F11 history combines persistent attacks, notifications, penalties, corrections and real command logs', async () => {
  await forest();
  await sql(
    "INSERT INTO attacks(id,actor,target,request_id,classification,wrong_index,edge_utc,committed_utc,game_ms) VALUES('historic-attack','C01','C02','atk-1','unknown_code',1,?,?,123)",
    now,
    now,
  );
  await sql(
    "INSERT INTO attack_corrections VALUES('historic-correction','historic-attack','J01','更正证据',?,'{}','{}')",
    now,
  );
  await confirm((await plan('/penalty lock C01 for 1m')).token);
  await confirm((await plan('/photon grant {C01,C02}')).token);
  await confirm((await plan('/tell C01 "请核对"')).token);
  const all = resultData(await command('/history C01 --limit 1000'));
  expect(all.items.map((r: {source: string}) => r.source)).toEqual(
    expect.arrayContaining([
      'attacks',
      'attack_corrections',
      'notice_queue',
      'audit_logs',
      'judge_command_log',
    ]),
  );
  expect(all.items.some((r: {id: string}) => r.id === 'historic-attack')).toBe(
    true,
  );
  expect(resultData(await command('/history C01 kind attack')).items).toEqual(
    expect.arrayContaining([expect.objectContaining({id: 'historic-attack'})]),
  );
  expect(resultData(await command('/history C01 kind penalty')).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({source: 'attacks'}),
      expect.objectContaining({source: 'audit_logs'}),
    ]),
  );
  expect(
    resultData(await command('/history C01 kind correction')).items,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({id: 'historic-correction'}),
    ]),
  );
  const commands = resultData(
    await command('/history C01 kind command --status executed'),
  );
  expect(
    commands.items.every(
      (r: {source: string}) => r.source === 'judge_command_log',
    ),
  ).toBe(true);
  expect(
    commands.items.some(
      (r: {record: {path: string}}) => r.record.path === 'photon grant',
    ),
  ).toBe(true);
  expect(resultData(await command('/inspect C01'))).toHaveProperty('flight');
  const restricted = resultData(await command('/history C01', communications));
  expect(
    restricted.items.every(
      (r: {source: string}) =>
        ![
          'attacks',
          'audit_logs',
          'judge_command_log',
          'attack_corrections',
        ].includes(r.source),
    ),
  ).toBe(true);
  expect(
    (await command('/history C01 kind penalty', communications)).status,
  ).toBe(403);
  expect((await command('/history C01', player)).status).toBe(403);
});

it('F11 applies history filters before pagination and keeps source waterlines across later queries', async () => {
  await forest();
  for (let i = 0; i < 120; i++) {
    await sql(
      "INSERT INTO event_log(id,kind,title,body,audience,owner,civilization_ids,game_ms,utc_ms,committed_utc) VALUES(?,'notice','历史','分页证据','personal','C01','[\"C01\"]',0,?,?)",
      `old-${i}`,
      now,
      now,
    );
  }
  const first = resultData(
    await command('/history C01 --limit 10 --search "分页证据"'),
  );
  expect(first.items).toHaveLength(10);
  expect(first.nextCursor).toBeTruthy();
  await sql(
    "INSERT INTO event_log(id,kind,title,body,audience,owner,civilization_ids,game_ms,utc_ms,committed_utc) VALUES('later','notice','新历史','分页证据','personal','C01','[\"C01\"]',0,?,?)",
    now,
    now,
  );
  const second = resultData(
    await command(
      `/history C01 --limit 10 --search "分页证据" --before ${first.nextCursor}`,
    ),
  );
  expect(second.items).toHaveLength(10);
  expect(second.watermark).toBe(first.watermark);
  expect(
    second.items.some(
      (r: {id: string}) =>
        first.items.some((p: {id: string}) => p.id === r.id) ||
        r.id === 'later',
    ),
  ).toBe(false);
  expect(
    (await command(`/history C02 --before ${first.nextCursor}`)).status,
  ).toBe(400);
  const old = resultData(await command('/history C01 --search "old-0"'));
  expect(old.items.some((r: {id: string}) => r.id === 'old-0')).toBe(true);
});
it('previews without committing; explicit target plans survive unrelated activity and time', async () => {
  await forest();
  const p = await plan('/photon grant C01');
  expect(await sql('SELECT photons FROM players WHERE id=?', 'C01')).toEqual([
    {photons: 0},
  ]);
  await sql("UPDATE players SET nickname='无关行动' WHERE id='C04'");
  await sql('UPDATE matches SET revision=revision+1');
  now += 180000;
  const r = await confirm(p.token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(await sql("SELECT tech,photons FROM players WHERE id='C01'")).toEqual([
    {tech: 1, photons: 1},
  ]);
});
it('invalidates changed dependencies and never accepts a different operator', async () => {
  await forest();
  const p = await plan('/resource set C01 broadcasts 2');
  await sql("UPDATE players SET broadcasts=1 WHERE id='C01'");
  expect((await confirm(p.token)).status).toBe(409);
  expect((await command('/confirm ' + p.token, communications)).status).toBe(
    400,
  );
});
it('executes a whole elimination batch before deciding final population, replays one result', async () => {
  await forest();
  const p = await plan('/player eliminate @alive');
  expect(await sql('SELECT COUNT(*) n FROM eliminations')).toEqual([{n: 0}]);
  const r = await confirm(p.token, 'same-confirm');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(
    await sql('SELECT COUNT(*) n FROM eliminations WHERE valid=1'),
  ).toEqual([{n: 4}]);
  expect(await sql('SELECT phase,finish_reason FROM matches')).toEqual([
    {phase: 'ended', finish_reason: 'all_eliminated'},
  ]);
  expect((await confirm(p.token, 'same-confirm')).body).toEqual(r.body);
  expect(await sql('SELECT COUNT(*) n FROM eliminations')).toEqual([{n: 4}]);
});
it('rejects a later invalid batch step and rolls back prior resources and notifications', async () => {
  await forest();
  const r = await command(
    '/batch run { photon grant C01; resource add C02 photons 2 }',
  );
  expect(r.status).toBe(400);
  expect(await sql('SELECT SUM(photons) n FROM players')).toEqual([{n: 0}]);
  expect(await sql('SELECT COUNT(*) n FROM notice_queue')).toEqual([{n: 0}]);
});
it('restores arbitrary eliminated players through new codes in a paused batch without premature finish', async () => {
  await forest();
  await sql("UPDATE matches SET paused_at=?,pause_reason='review'", now);
  await sql(
    "INSERT INTO clock_pauses(opened,reason,actor) VALUES(?,'review','J01')",
    now,
  );
  const p = await plan(
    '/batch run { player eliminate @alive; player restore C01; player restore C02 }',
  );
  const r = await confirm(p.token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(
    await sql(
      'SELECT id,status FROM players JOIN flights ON player_id=id ORDER BY id',
    ),
  ).toEqual([
    {id: 'C01', status: 'issued'},
    {id: 'C02', status: 'issued'},
    {id: 'C03', status: 'eliminated'},
    {id: 'C04', status: 'eliminated'},
  ]);
  expect(await sql('SELECT phase FROM matches')).toEqual([{phase: 'forest'}]);
  expect(
    await sql("SELECT COUNT(*) n FROM sighting_codes WHERE status='reserved'"),
  ).toEqual([{n: 2}]);
});
it('parses selectors, tags, score ranges and true boolean precedence', async () => {
  await forest();
  await command('/tag add {C01,C02} "奖励"');
  await sql("UPDATE attack_controls SET wrong=2 WHERE player_id='C02'");
  const q = await command(
    '/selector inspect @alive[tag="奖励",scores={wrong=1..2,photons=0}]',
  );
  expect(JSON.parse((q.body as OperationResult).message).candidates).toEqual([
    'C02',
  ]);
  const p = await plan(
    '/execute as @alive if (tag @s "奖励" and not score @s wrong matches 0) run { photon grant @s }',
  );
  const r = await confirm(p.token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(await sql('SELECT id FROM players WHERE photons=1')).toEqual([
    {id: 'C02'},
  ]);
});
it('binds macro target parameters once and rejects recursive definitions', async () => {
  await forest();
  const def = await command(
    '/macro define "补给" params (who:target) run { photon grant $who; tell $who "${id}请查收" }',
  );
  expect(def.status, JSON.stringify(def.body)).toBe(200);
  const p = await plan('/macro run "补给" (@random[alive])');
  const r = await confirm(p.token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const winners = await sql('SELECT id FROM players WHERE photons=1');
  expect(winners).toHaveLength(1);
  const messages = await sql(
    "SELECT owner FROM event_log WHERE title='赛事通知'",
  );
  expect(messages).toEqual([{owner: winners[0]!.id}]);
  expect(
    (await command('/macro define "循环" run { macro run "循环" }')).status,
  ).toBe(400);
});
it('schedules persistent UTC messages and game tasks freeze while paused', async () => {
  await forest();
  const p = await plan(
    '/schedule create utc in 1m run { tell C01 "到点通知" }',
  );
  expect((await confirm(p.token)).status).toBe(200);
  await evictDurableObject(stub());
  now += 60001;
  await call('/public/match');
  expect(
    await sql("SELECT body FROM notice_queue WHERE title='赛事通知'"),
  ).toEqual([{body: '【赛事通知】\n到点通知'}]);
  await call('/public/match');
  expect(
    await sql("SELECT COUNT(*) n FROM notice_queue WHERE title='赛事通知'"),
  ).toEqual([{n: 1}]);
  await sql("UPDATE matches SET paused_at=?,pause_reason='test'", now);
  const g = await plan(
    '/schedule create game in 1m run { tell C02 "游戏通知" }',
  );
  expect((await confirm(g.token)).status).toBe(200);
  now += 120000;
  await call('/public/match');
  expect(
    await sql("SELECT COUNT(*) n FROM notice_queue WHERE body='游戏通知'"),
  ).toEqual([{n: 0}]);
});
it('puts late strong tasks into review and respects revoked creator permissions', async () => {
  await forest();
  const p = await plan('/schedule create utc in 1m run { photon grant C01 }');
  expect((await confirm(p.token)).status).toBe(200);
  now += 60001;
  await call('/public/match');
  expect(
    await sql("SELECT status FROM command_objects WHERE kind='schedule'"),
  ).toEqual([{status: 'review'}]);
  expect(await sql('SELECT SUM(photons) n FROM players')).toEqual([{n: 0}]);
});
it('preserves freeze and original secrets when cancelling and relocking future starts', async () => {
  await sql("UPDATE flights SET status='staged',departed=?,staged=?", now, now);
  const p = await plan(
    `/match arm-release at "${new Date(now + 60000).toISOString()}"`,
  );
  expect((await confirm(p.token)).status).toBe(200);
  const cancel = await plan('/match cancel-release');
  expect((await confirm(cancel.token)).status).toBe(200);
  expect(await sql('SELECT phase,release_at FROM matches')).toEqual([
    {phase: 'armed', release_at: null},
  ]);
  expect((await command('/parameter set singer-percent 10')).status).toBe(409);
  const relock = await plan(
    `/match arm-release at "${new Date(now + 120000).toISOString()}"`,
  );
  expect((await confirm(relock.token)).status).toBe(200);
});
it('projects civilization secrets by duty and hides other authors templates', async () => {
  const result = await command('/inspect C01', communications);
  expect(result.status).toBe(200);
  const detail = JSON.parse((result.body as OperationResult).message);
  expect(detail.arms).toBeNull();
  expect(detail.voyages).toEqual([]);
  const events = await login('J03');
  const limited = JSON.parse(
    ((await command('/inspect C01', events)).body as OperationResult).message,
  );
  expect(limited.homeworld).toBeNull();
  expect((await command('/codebook list', communications)).status).toBe(403);
  expect((await command('/command history', communications)).status).toBe(403);
});
it('allows fault queries and individual recovery actions but blocks composed battle writes', async () => {
  await forest();
  await sql(
    "INSERT INTO scheduled_events(id,kind,clock,due,priority,payload) VALUES('broken','song_visit','utc',?,1,'{')",
    now - 1,
  );
  expect((await command('/scheduler health')).status).toBe(200);
  expect((await command('/photon grant C01')).status).toBe(503);
  expect(
    (await command('/batch run { clock pause; photon grant C01 }')).status,
  ).toBe(503);
  const p = await plan('/clock pause');
  expect((await confirm(p.token)).status).toBe(200);
  expect(await sql('SELECT paused_at FROM matches')).toEqual([
    {paused_at: now},
  ]);
  const cancel = await plan('/event cancel broken');
  expect((await confirm(cancel.token)).status).toBe(200);
  expect(
    await sql("SELECT status FROM scheduled_events WHERE id='broken'"),
  ).toEqual([{status: 'cancelled'}]);
});
it('retains message tasks after the match ends and cancels battle tasks', async () => {
  await forest();
  const message = await plan(
    '/schedule create utc in 1m run { tell C01 "赛后集合" }',
  );
  expect((await confirm(message.token)).status).toBe(200);
  const battle = await plan(
    '/schedule create utc in 1m run { photon grant C01 } --late run',
  );
  expect((await confirm(battle.token)).status).toBe(200);
  const end = await plan('/player eliminate @alive');
  expect((await confirm(end.token)).status).toBe(200);
  now += 60001;
  await call('/public/match');
  expect(
    await sql(
      "SELECT body FROM notice_queue WHERE body='【赛事通知】\n赛后集合'",
    ),
  ).toEqual([{body: '【赛事通知】\n赛后集合'}]);
  expect(
    await sql(
      "SELECT status FROM command_objects WHERE kind='schedule' ORDER BY created_utc,id",
    ),
  ).toEqual(
    expect.arrayContaining([{status: 'complete'}, {status: 'cancelled'}]),
  );
});
it('rechecks task creator authority and stops a sequential job at its failed step', async () => {
  await forest();
  const task = await plan(
    '/schedule create utc in 1m run { photon grant C01 } --late run',
  );
  expect((await confirm(task.token)).status).toBe(200);
  const job = await plan(
    '/batch run { photon grant C02; resource add C03 photons 2; photon grant C04 } --mode sequential',
  );
  expect((await confirm(job.token)).status).toBe(200);
  now += 2;
  await call('/public/match');
  now += 2;
  await call('/public/match');
  expect(
    await sql("SELECT status FROM command_objects WHERE kind='job'"),
  ).toEqual([{status: 'failed'}]);
  expect(await sql('SELECT id FROM players WHERE photons=1')).toEqual([
    {id: 'C02'},
  ]);
  await sql("UPDATE accounts SET permissions='[\"overview\"]' WHERE id='J01'");
  now += 60000;
  await call('/public/match');
  expect(
    await sql("SELECT status FROM command_objects WHERE kind='schedule'"),
  ).toEqual([{status: 'failed'}]);
  expect(await sql("SELECT photons FROM players WHERE id='C01'")).toEqual([
    {photons: 0},
  ]);
});
it('preserves authorized tasks through checkpoint rollback and waits for recovery review', async () => {
  const checkpoint = await runInDurableObject(stub(), (_i, state) =>
    createCheckpoint(new Engine(new Store(state.storage), bindings)),
  );
  const task = await plan(
    '/schedule create utc in 1m run { tell C01 "恢复后仍按原时刻" }',
  );
  expect((await confirm(task.token)).status).toBe(200);
  await runInDurableObject(stub(), async (_i, state) => {
    const e = new Engine(new Store(state.storage), bindings);
    e.now = () => now;
    const carry = await prepareRecovery(e, {
      target: checkpoint,
      reason: '指令任务恢复回归',
    });
    const target = await openCheckpoint(e, checkpoint);
    restoreCheckpointTables(e, target.tables);
    await completeRecovery(e, carry);
  });
  now += 60001;
  await call('/public/match');
  expect(
    await sql("SELECT body FROM notice_queue WHERE body='恢复后仍按原时刻'"),
  ).toEqual([]);
  await runInDurableObject(stub(), (_i, state) =>
    finishRecovery(new Engine(new Store(state.storage), bindings)),
  );
  await call('/public/match');
  expect(
    await sql(
      "SELECT body FROM notice_queue WHERE body='【赛事通知】\n恢复后仍按原时刻'",
    ),
  ).toEqual([{body: '【赛事通知】\n恢复后仍按原时刻'}]);
  expect(
    await sql("SELECT status FROM command_objects WHERE kind='schedule'"),
  ).toEqual([{status: 'complete'}]);
});
it('keeps snapshot target scope while live tasks see later eligible players', async () => {
  await forest();
  await command('/tag add C01 "范围"');
  const snapshot = await plan(
    '/schedule create utc in 1m run { tell @alive[tag="范围"] "创建时范围" } --targets snapshot',
  );
  expect((await confirm(snapshot.token)).status).toBe(200);
  const live = await plan(
    '/schedule create utc in 1m run { tell @alive[tag="范围"] "执行时范围" }',
  );
  expect((await confirm(live.token)).status).toBe(200);
  await command('/tag add C02 "范围"');
  now += 60001;
  await call('/public/match');
  expect(
    await sql(
      "SELECT target FROM notice_queue WHERE body='【赛事通知】\n创建时范围' ORDER BY target",
    ),
  ).toEqual([{target: 'C01'}]);
  expect(
    await sql(
      "SELECT target FROM notice_queue WHERE body='【赛事通知】\n执行时范围' ORDER BY target",
    ),
  ).toEqual([{target: 'C01'}, {target: 'C02'}]);
});
it('pins the previewed macro version when a later definition is published', async () => {
  await forest();
  await command('/macro define "版本" run { photon grant C01 }');
  const p = await plan('/macro run "版本"');
  await command('/macro define "版本" run { photon grant C02 }');
  expect((await confirm(p.token)).status).toBe(200);
  expect(await sql('SELECT id FROM players WHERE photons=1')).toEqual([
    {id: 'C01'},
  ]);
});
