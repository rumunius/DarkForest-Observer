import {
  object,
  parseJson,
  text,
} from '../../../../packages/contracts/src/backend';
import {token} from '../security/crypto';
import {SCHEMA_VERSION} from '../storage/schema';
import {DEFAULT_SITE, requireThat, type Actor} from '../storage/store';
import type {MatchControlContext} from './match_control_context';

/** 只在空对象内初始化场次身份和配置，重试由入口原操作收据处理。 */
export function initializeControlledMatch(
  context: MatchControlContext,
): unknown {
  const {db, payload, request, fingerprint, engine, hash} = context;
  requireThat(
    !db.one<Record<string, SqlStorageValue>>('SELECT id FROM matches'),
    'ALREADY_INITIALIZED',
    '已有比赛禁止覆盖。',
  );
  requireThat(
    payload.kind === 'official' || payload.kind === 'trial',
    'BAD_KIND',
    '请选择正式或试玩。',
    400,
  );
  db.exec(
    'INSERT INTO matches(id,key_fingerprint,site_json,created_at) VALUES(?,?,?,?)',
    request.matchId,
    fingerprint,
    JSON.stringify({
      ...DEFAULT_SITE,
      title: text(payload.name, 100),
      description:
        typeof payload.description === 'string'
          ? text(payload.description, 2000, 0)
          : DEFAULT_SITE.description,
    }),
    engine.now(),
  );
  db.exec(
    'INSERT INTO match_identity(id,kind,creation_id,body_hash) VALUES(?,?,?,?)',
    request.matchId,
    payload.kind,
    request.id,
    hash,
  );
  if (payload.template) {
    const template = object(payload.template);
    const site = parseJson(db.match().site_json) as typeof DEFAULT_SITE;
    site.colors = object(template.colors) as typeof DEFAULT_SITE.colors;
    db.exec('UPDATE matches SET site_json=?', JSON.stringify(site));
    db.exec(
      "UPDATE settings SET value=? WHERE key='parameters'",
      JSON.stringify(object(template.parameters)),
    );
  }
  return {
    matchId: request.matchId,
    schemaVersion: SCHEMA_VERSION,
    fingerprint,
    state: 'draft',
  };
}

/** 登记原地旧比赛及独立账号映射，撤销旧会话但保留原战局记录。 */
export function adoptLegacyMatch(context: MatchControlContext): unknown {
  const {db, payload, request, hash, engine} = context;
  const matchState = db.match();
  requireThat(
    !db.one<Record<string, SqlStorageValue>>('SELECT id FROM match_identity'),
    'ALREADY_ADOPTED',
    '旧比赛已登记。',
  );
  requireThat(
    matchState.revision === Number(payload.expectedRevision),
    'VERSION_CONFLICT',
    '旧比赛记录已变化，请重新检查与保存备份。',
  );
  requireThat(
    matchState.phase === 'setup' ||
      matchState.phase === 'ended' ||
      matchState.paused_at !== null,
    'PAUSE_REQUIRED',
    '旧比赛须先暂停。',
  );
  requireThat(
    Array.isArray(payload.accounts),
    'BAD_MAPPING',
    '请核对旧账号逐项映射。',
    400,
  );
  db.exec(
    "INSERT INTO match_identity(id,kind,creation_id,body_hash,key_version,management_state) VALUES(?,?,?,?,1,'available')",
    matchState.id,
    payload.kind as string,
    request.id,
    hash,
  );
  for (const raw of payload.accounts) {
    const row = object(raw);
    const localId = text(row.localId, 16);
    const account = db.one<Actor>('SELECT * FROM accounts WHERE id=?', localId);
    requireThat(account, 'ACCOUNT_MISSING', '旧账号映射不存在。');
    const assignmentId = account.role === 'judge' ? crypto.randomUUID() : null;
    db.exec(
      "INSERT INTO memberships(account_id,kind,name,local_id,state,epoch,assignment_id) VALUES(?,?,?,?,'bound',?,?)",
      text(row.accountId, 100),
      account.role === 'judge' ? 'staff' : 'player',
      account.name,
      localId,
      account.version,
      assignmentId,
    );
    if (assignmentId) {
      db.exec(
        'INSERT INTO staff_assignments VALUES(?,?,?,?,NULL,?)',
        assignmentId,
        row.accountId as string,
        localId,
        engine.now(),
        account.version,
      );
    }
    if (
      account.role === 'player' &&
      matchState.start_settled !== null &&
      db.one<Record<string, SqlStorageValue>>(
        'SELECT player_id FROM roster_members WHERE player_id=?',
        localId,
      )
    ) {
      db.exec(
        'INSERT INTO participation_history VALUES(?,?,?)',
        row.accountId as string,
        localId,
        engine.now(),
      );
    }
    db.exec(
      'UPDATE accounts SET credential_hash=? WHERE id=?',
      `migrated:${token()}`,
      localId,
    );
  }
  db.exec('UPDATE sessions SET revoked=1');
  db.exec('DELETE FROM previews');
  return {
    matchId: matchState.id,
    revision: matchState.revision,
    issued: db.one<Record<string, SqlStorageValue>>(
      'SELECT COUNT(*) AS count FROM sighting_codes',
    ),
    accounts: payload.accounts.length,
  };
}

/** 发布前核对当前有效总裁判与至少两名已绑定玩家。 */
export function publishPreparationEntry(context: MatchControlContext): unknown {
  const {db} = context;
  requireThat(
    db.one<Record<string, SqlStorageValue>>(
      "SELECT a.id FROM accounts a JOIN staff_assignments s ON s.seat_id=a.id JOIN memberships m ON m.account_id=s.account_id WHERE a.id='J01' AND a.enabled=1 AND s.ended_utc IS NULL AND m.state='bound' AND m.local_id=a.id AND m.epoch=a.version",
    ),
    'STAFF_REQUIRED',
    '发布前需要一名已任职的总裁判。',
  );
  requireThat(
    db.one<{n: number}>('SELECT COUNT(*) AS n FROM players')!.n >= 2,
    'PLAYERS_REQUIRED',
    '发布准备入口前至少绑定两名玩家。',
  );
  db.exec("UPDATE match_identity SET management_state='available'");
  return {state: 'available'};
}
