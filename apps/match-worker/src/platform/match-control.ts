import type { BackendEnv, MatchGrant } from '../rpc/types';
import type { Engine } from '../services/engine';
import { DEFAULT_SITE, requireThat, type Actor } from '../storage/store';
import { digest, token } from '../security/crypto';
import { controlSignature } from './security';
import { integer, object, stableJson, text } from '../../../../packages/contracts/src/backend';
import { SCHEMA_VERSION } from '../storage/schema';
import { historyRecord } from './history';

export interface ControlRequest {
  id: string;
  matchId: string;
  action: string;
  actor: string;
  reason: string;
  payload: Record<string, unknown>;
  expires: number;
}
export const HEAD_PERMISSIONS = [
  'overview',
  'homeworlds',
  'preflight',
  'notices',
  'endgame',
  'players',
  'events',
  'attacks',
  'results',
  'clock',
  'equipment',
  'effects',
  'commands',
  'system',
  'audit',
  'settings',
  'account',
];
const seats: Record<string, string[]> = {
  J01: HEAD_PERMISSIONS,
  J02: ['overview', 'homeworlds', 'notices', 'players', 'events', 'account'],
  J03: ['overview', 'notices', 'events', 'players', 'account'],
};
export function membershipActor(e: Engine, grant: MatchGrant): Actor {
  requireThat(
    grant.expires > e.now() && grant.matchId === e.matchId,
    'AUTHORIZATION_EXPIRED',
    '登录已过期，请重新登录。',
    401,
  );
  const member = e.db.one<{ local_id: string | null; epoch: number; state: string; kind: string }>(
    'SELECT * FROM memberships WHERE account_id=?',
    grant.accountId,
  );
  const fence = e.db.one<{ auth_epoch: number; disabled: number }>(
    'SELECT * FROM authorization_fences WHERE account_id=?',
    grant.accountId,
  );
  requireThat(
    member?.state === 'bound' &&
      member.local_id &&
      member.kind === grant.audience &&
      (!fence || (!fence.disabled && fence.auth_epoch <= grant.authEpoch)),
    'MATCH_FORBIDDEN',
    '当前账号没有本场访问权限。',
    403,
  );
  const actor = e.db.one<Actor>('SELECT * FROM accounts WHERE id=? AND enabled=1', member.local_id);
  requireThat(
    actor && actor.version === member.epoch,
    'ASSIGNMENT_CHANGED',
    '本场身份已变更，请重新进入比赛。',
    403,
  );
  return actor;
}
function freezeCheck(e: Engine) {
  requireThat(
    e.db.match().phase === 'setup' &&
      !e.db.one("SELECT key FROM settings WHERE key='parameters_frozen'"),
    'ROSTER_LOCKED',
    '首次锁定 T0 后不能新增、替换或绑定选手。',
  );
}
function bindCivilization(e: Engine, accountId: string, name: string) {
  freezeCheck(e);
  const db = e.db;
  const used = new Set(db.all<{ id: string }>('SELECT id FROM players').map((p) => p.id));
  let n = 1;
  while (n <= 350 && used.has(`C${String(n).padStart(2, '0')}`)) n++;
  requireThat(n <= 350, 'CAPACITY', '本场最多绑定350个文明。');
  const id = `C${String(n).padStart(2, '0')}`;
  db.exec(
    'INSERT INTO accounts(id,match_id,role,name,credential_hash,permissions) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,credential_hash=excluded.credential_hash,enabled=1,version=accounts.version+1',
    id,
    e.matchId,
    'player',
    name,
    `platform-only:${token()}`,
    '[]',
  );
  db.exec('INSERT INTO players(id) VALUES(?)', id);
  db.exec('INSERT INTO flights(player_id) VALUES(?)', id);
  db.exec('INSERT INTO attack_controls(player_id) VALUES(?)', id);
  db.exec(
    "UPDATE memberships SET local_id=?,state='bound',epoch=(SELECT version FROM accounts WHERE id=?) WHERE account_id=?",
    id,
    id,
    accountId,
  );
  return { accepted: true, localId: id };
}
function cancelManagement(e: Engine, seat: string) {
  e.db.exec(
    "UPDATE command_objects SET status='review',version=version+1 WHERE actor=? AND kind IN ('schedule','job','plan') AND status='pending'",
    seat,
  );
  e.db.exec('DELETE FROM previews WHERE actor=?', seat);
  e.db.exec('UPDATE sessions SET revoked=1 WHERE account_id=?', seat);
}
export async function matchControl(
  e: Engine,
  env: BackendEnv,
  request: ControlRequest,
  signature: string,
): Promise<unknown> {
  requireThat(
    request.expires >= Date.now() &&
      request.expires <= Date.now() + 60000 &&
      signature === (await controlSignature(env, stableJson(request))),
    'FORBIDDEN',
    '内部授权无效。',
    403,
  );
  requireThat(request.matchId === e.matchId, 'MATCH_MISMATCH', '请求的场次与对象身份不一致。', 409);
  requireThat(
    request.matchId === e.env.MATCH_ID,
    'OBJECT_ID_MISMATCH',
    '比赛与已登记对象地址不一致。',
  );
  if (request.action === 'history-record') return historyRecord(e, request.actor, request.payload);
  const hash = await digest(stableJson({ ...request, expires: 0 }));
  const prior = e.db.one<{ body_hash: string; result: string }>(
    'SELECT * FROM control_operations WHERE id=?',
    request.id,
  );
  if (prior) {
    requireThat(prior.body_hash === hash, 'OPERATION_CONFLICT', '该操作编号已用于不同内容。');
    return JSON.parse(prior.result);
  }
  const p = object(request.payload);
  if (request.action === 'initialize') e.platformKeys = true;
  const keys = request.action === 'initialize' ? await e.keys() : undefined;
  const fingerprint = keys?.fingerprint ?? '';
  return e.db.tx(() => {
    const old = e.db.one<{ body_hash: string; result: string }>(
      'SELECT * FROM control_operations WHERE id=?',
      request.id,
    );
    if (old) {
      requireThat(old.body_hash === hash, 'OPERATION_CONFLICT', '操作编号冲突。');
      return JSON.parse(old.result);
    }
    const db = e.db;
    let result: unknown;
    if (request.action === 'initialize') {
      requireThat(!db.one('SELECT id FROM matches'), 'ALREADY_INITIALIZED', '已有比赛禁止覆盖。');
      requireThat(
        p.kind === 'official' || p.kind === 'trial',
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
          title: text(p.name, 100),
          description:
            typeof p.description === 'string'
              ? text(p.description, 2000, 0)
              : DEFAULT_SITE.description,
        }),
        e.now(),
      );
      db.exec(
        'INSERT INTO match_identity(id,kind,creation_id,body_hash) VALUES(?,?,?,?)',
        request.matchId,
        p.kind,
        request.id,
        hash,
      );
      if (p.template) {
        const template = object(p.template),
          site = JSON.parse(db.match().site_json) as typeof DEFAULT_SITE;
        site.colors = object(template.colors) as typeof DEFAULT_SITE.colors;
        db.exec('UPDATE matches SET site_json=?', JSON.stringify(site));
        db.exec(
          "UPDATE settings SET value=? WHERE key='parameters'",
          JSON.stringify(object(template.parameters)),
        );
      }
      result = {
        matchId: request.matchId,
        schemaVersion: SCHEMA_VERSION,
        fingerprint,
        state: 'draft',
      };
    } else if (request.action === 'adopt-legacy') {
      const m = db.match();
      requireThat(!db.one('SELECT id FROM match_identity'), 'ALREADY_ADOPTED', '旧比赛已登记。');
      requireThat(
        m.revision === Number(p.expectedRevision),
        'VERSION_CONFLICT',
        '旧比赛记录已变化，请重新检查与保存备份。',
      );
      requireThat(
        m.phase === 'setup' || m.phase === 'ended' || m.paused_at !== null,
        'PAUSE_REQUIRED',
        '旧比赛须先暂停。',
      );
      requireThat(Array.isArray(p.accounts), 'BAD_MAPPING', '请核对旧账号逐项映射。', 400);
      db.exec(
        "INSERT INTO match_identity(id,kind,creation_id,body_hash,key_version,management_state) VALUES(?,?,?,?,1,'available')",
        m.id,
        p.kind as string,
        request.id,
        hash,
      );
      for (const raw of p.accounts) {
        const row = object(raw),
          localId = text(row.localId, 16),
          account = db.one<Actor>('SELECT * FROM accounts WHERE id=?', localId);
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
        if (assignmentId)
          db.exec(
            'INSERT INTO staff_assignments VALUES(?,?,?,?,NULL,?)',
            assignmentId,
            row.accountId as string,
            localId,
            e.now(),
            account.version,
          );
        if (
          account.role === 'player' &&
          m.start_settled !== null &&
          db.one('SELECT player_id FROM roster_members WHERE player_id=?', localId)
        )
          db.exec(
            'INSERT INTO participation_history VALUES(?,?,?)',
            row.accountId as string,
            localId,
            e.now(),
          );
        db.exec('UPDATE accounts SET credential_hash=? WHERE id=?', `migrated:${token()}`, localId);
      }
      db.exec('UPDATE sessions SET revoked=1');
      db.exec('DELETE FROM previews');
      result = {
        matchId: m.id,
        revision: m.revision,
        issued: db.one('SELECT COUNT(*) AS count FROM sighting_codes'),
        accounts: p.accounts.length,
      };
    } else {
      requireThat(
        db.one('SELECT id FROM match_identity'),
        'LEGACY_MIGRATION_REQUIRED',
        '请先通过部署向导登记旧比赛。',
      );
      requireThat(
        !db.match().recovery_state || ['summary', 'fence', 'erase'].includes(request.action),
        'RECOVERY_LOCKED',
        '比赛正在恢复，成员与任职变更须等待核对。',
      );
      requireThat(
        !['purged', 'imported_archive'].includes(
          String(
            db.one<{ management_state: string }>('SELECT management_state FROM match_identity')
              ?.management_state,
          ),
        ),
        'MATCH_CLOSED',
        '该比赛只保留历史墓碑。',
        410,
      );
      if (request.action === 'template') {
        const site = JSON.parse(db.match().site_json) as typeof DEFAULT_SITE;
        result = {
          description: site.description,
          colors: site.colors,
          parameters: db.parameters(),
        };
      } else if (request.action === 'erase') {
        requireThat(db.match().phase === 'ended', 'ENDED_REQUIRED', '进行中的比赛不能清理。');
        const generation = integer(p.generation, 1),
          identity = db.one<{ erasure_generation: number }>(
            'SELECT erasure_generation FROM match_identity',
          )!;
        if (generation > identity.erasure_generation) {
          for (const table of [
            'homeworlds',
            'intel_grants',
            'request_journal',
            'previews',
            'credential_deliveries',
            'attack_corrections',
            'judge_eliminations',
            'broadcasts',
            'photon_shots',
            'event_log',
            'notice_queue',
            'notice_actions',
          ]) {
            // notice actions reference notices; delete their children first.
            if (table === 'notice_queue') db.exec('DELETE FROM notice_actions');
            db.exec(`DELETE FROM ${table}`);
          }
          db.exec("UPDATE sighting_codes SET ciphertext=''");
          db.exec('UPDATE attacks SET before_json=NULL');
          db.exec(
            "UPDATE scheduled_events SET payload='{}',status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END",
          );
          for (const row of db.all<{ version: number; snapshot_json: string }>(
            'SELECT version,snapshot_json FROM result_reports WHERE snapshot_json IS NOT NULL',
          )) {
            const standings = (JSON.parse(row.snapshot_json) as Record<string, unknown>[]).map(
              ({ id, nickname, rank, tied, kills, eliminatedAt, eliminationReason }) => ({
                id,
                nickname,
                rank,
                tied,
                kills,
                eliminatedAt,
                eliminationReason,
              }),
            );
            db.exec(
              'UPDATE result_reports SET snapshot_json=? WHERE version=?',
              JSON.stringify(standings),
              row.version,
            );
          }
          db.exec("UPDATE command_objects SET data='{}',status='cancelled'");
          db.exec('DELETE FROM control_operations');
          db.exec('DELETE FROM sessions');
          db.exec(
            "UPDATE match_identity SET erasure_generation=?,management_state='archived'",
            generation,
          );
        }
        result = { erasureGeneration: generation, scope: 'nonessential-secrets', verified: true };
      } else if (request.action === 'summary') {
        const m = db.match();
        result = {
          phase: m.phase,
          revision: m.revision,
          paused: m.paused_at !== null,
          endedUtc: m.ended_utc,
          recovering: !!m.recovery_state,
          reportVersion: db.one<{ version: number }>(
            'SELECT MAX(version) AS version FROM result_reports',
          )?.version,
          erasureGeneration: db.one<{ erasure_generation: number }>(
            'SELECT erasure_generation FROM match_identity',
          )?.erasure_generation,
          players: db.roster().length,
          participants: db
            .all<{ account_id: string }>('SELECT account_id FROM participation_history')
            .map((row) => row.account_id),
          members: db.all('SELECT * FROM memberships'),
          assignments: db.all('SELECT * FROM staff_assignments'),
          seatVersions: db.all("SELECT id,version FROM accounts WHERE role='judge'"),
          managementState: db.one('SELECT management_state FROM match_identity')?.management_state,
        };
      } else if (request.action === 'invite') {
        if (p.kind === 'player') freezeCheck(e);
        const account = text(p.accountId, 100);
        requireThat(
          !db.one('SELECT account_id FROM memberships WHERE account_id=?', account),
          'ALREADY_INVITED',
          '账号已在本场，请查看现有邀请。',
        );
        db.exec(
          'INSERT INTO memberships(account_id,kind,name,state) VALUES(?,?,?,?)',
          account,
          p.kind as string,
          text(p.name, 100),
          'invited',
        );
        result = { invited: true };
      } else if (request.action === 'remove-member') {
        requireThat(
          db.one('SELECT management_state FROM match_identity')?.management_state === 'draft',
          'MATCH_ALREADY_PUBLISHED',
          '发布准备入口后不能移除本场成员。',
        );
        freezeCheck(e);
        requireThat(
          db.match().revision === integer(p.expectedRevision, 0),
          'VERSION_CONFLICT',
          '本场成员或状态已变化，请刷新后重新确认移除。',
        );
        const account = text(p.accountId, 100),
          member = db.one<{ kind: string; local_id: string | null; name: string }>(
            'SELECT * FROM memberships WHERE account_id=?',
            account,
          );
        requireThat(member, 'MEMBER_NOT_FOUND', '该账号已不在本场成员中。', 404);
        const localId = member.local_id;
        if (localId) {
          cancelManagement(e, localId);
          db.exec('UPDATE accounts SET enabled=0,version=version+1 WHERE id=?', localId);
          if (member.kind === 'player') {
            db.exec('DELETE FROM roster_members WHERE player_id=?', localId);
            db.exec('DELETE FROM homeworlds WHERE player_id=?', localId);
            db.exec('DELETE FROM attack_controls WHERE player_id=?', localId);
            db.exec('DELETE FROM flights WHERE player_id=?', localId);
            db.exec('DELETE FROM players WHERE id=?', localId);
          } else {
            db.exec(
              'UPDATE staff_assignments SET ended_utc=? WHERE account_id=? AND ended_utc IS NULL',
              e.now(),
              account,
            );
          }
        }
        db.exec('DELETE FROM memberships WHERE account_id=?', account);
        result = { removed: true, accountId: account, name: member.name, releasedLocalId: localId };
      } else if (request.action === 'accept') {
        const member = db.one<{
          kind: string;
          state: string;
          name: string;
          local_id: string | null;
        }>('SELECT * FROM memberships WHERE account_id=?', request.actor);
        requireThat(
          member && ['invited', 'accepted', 'bound'].includes(member.state),
          'INVITATION_REQUIRED',
          '没有待接受的本场邀请。',
          403,
        );
        requireThat(p.consent === true, 'CONSENT_REQUIRED', '请先确认活动说明与数据期限。', 400);
        if (member.state === 'bound') result = { accepted: true, localId: member.local_id };
        else if (member.kind === 'player') result = bindCivilization(e, request.actor, member.name);
        else {
          if (member.state === 'invited')
            db.exec(
              "UPDATE memberships SET state='accepted',epoch=epoch+1 WHERE account_id=?",
              request.actor,
            );
          result = { accepted: true };
        }
      } else if (request.action === 'bind') {
        freezeCheck(e);
        const member = db.one<{ kind: string; name: string; state: string }>(
          'SELECT * FROM memberships WHERE account_id=?',
          request.actor,
        );
        requireThat(
          member?.kind === 'player' && member.state === 'accepted',
          'ACCEPT_FIRST',
          '请先接受本场邀请。',
          403,
        );
        result = bindCivilization(e, request.actor, member.name);
      } else if (request.action === 'assign') {
        const account = text(p.accountId, 100),
          seat = text(p.seat, 3);
        requireThat(seats[seat], 'BAD_SEAT', '请选择三个既有裁判岗位。', 400);
        const member = db.one<{
          kind: string;
          name: string;
          state: string;
          local_id: string | null;
        }>('SELECT * FROM memberships WHERE account_id=?', account);
        requireThat(
          member?.kind === 'staff' && member.state === 'accepted' && !member.local_id,
          'STAFF_ACCEPT_FIRST',
          '需要已接受邀请且未在本场任职的独立工作人员。',
        );
        const current = db.one<Actor>('SELECT * FROM accounts WHERE id=?', seat);
        const epoch = current ? current.version + 1 : 1;
        requireThat(
          Number(p.expectedVersion) === (current?.version ?? 0),
          'VERSION_CONFLICT',
          '席位已变化，请重新预览。',
        );
        db.exec(
          'UPDATE staff_assignments SET ended_utc=? WHERE seat_id=? AND ended_utc IS NULL',
          e.now(),
          seat,
        );
        db.exec(
          "UPDATE memberships SET state='revoked',local_id=NULL,epoch=epoch+1 WHERE local_id=?",
          seat,
        );
        cancelManagement(e, seat);
        const assignment = crypto.randomUUID();
        db.exec(
          'INSERT INTO accounts(id,match_id,role,name,credential_hash,permissions,version) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,credential_hash=excluded.credential_hash,permissions=excluded.permissions,enabled=1,version=excluded.version',
          seat,
          e.matchId,
          'judge',
          member.name,
          `platform-only:${token()}`,
          JSON.stringify(seats[seat]),
          epoch,
        );
        db.exec(
          "UPDATE memberships SET local_id=?,state='bound',epoch=?,assignment_id=? WHERE account_id=?",
          seat,
          epoch,
          assignment,
          account,
        );
        db.exec(
          'INSERT INTO staff_assignments VALUES(?,?,?,?,NULL,?)',
          assignment,
          account,
          seat,
          e.now(),
          epoch,
        );
        e.notice(request.id, 'group', '设置了裁判', `裁判 ${seat} 已设置。`);
        result = { seat, epoch, assignmentId: assignment };
      } else if (request.action === 'fence') {
        db.exec(
          'INSERT INTO authorization_fences VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET auth_epoch=MAX(auth_epoch,excluded.auth_epoch),disabled=CASE WHEN excluded.auth_epoch>=auth_epoch THEN excluded.disabled ELSE disabled END',
          text(p.accountId, 100),
          integer(p.authEpoch, 1),
          p.disabled === true ? 1 : 0,
        );
        const member = db.one<{ local_id: string | null }>(
          'SELECT local_id FROM memberships WHERE account_id=?',
          p.accountId as string,
        );
        if (p.disabled && member?.local_id) cancelManagement(e, member.local_id);
        result = { fenced: true, authEpoch: p.authEpoch };
      } else if (request.action === 'publish') {
        requireThat(
          db.one(
            "SELECT a.id FROM accounts a JOIN staff_assignments s ON s.seat_id=a.id JOIN memberships m ON m.account_id=s.account_id WHERE a.id='J01' AND a.enabled=1 AND s.ended_utc IS NULL AND m.state='bound' AND m.local_id=a.id AND m.epoch=a.version",
          ),
          'STAFF_REQUIRED',
          '发布前需要一名已任职的总裁判。',
        );
        requireThat(
          db.one<{ n: number }>('SELECT COUNT(*) AS n FROM players')!.n >= 2,
          'PLAYERS_REQUIRED',
          '发布准备入口前至少绑定两名玩家。',
        );
        db.exec("UPDATE match_identity SET management_state='available'");
        result = { state: 'available' };
      } else throw new Error('UNKNOWN_CONTROL_ACTION');
      if (!['summary', 'template'].includes(request.action)) db.bump();
    }
    if (!['summary', 'template'].includes(request.action))
      e.audit(request.actor, `platform:${request.action}`, request.matchId, request.reason, result);
    if (!['summary', 'template'].includes(request.action))
      db.exec(
        'INSERT INTO control_operations VALUES(?,?,?)',
        request.id,
        hash,
        JSON.stringify(result),
      );
    return result;
  });
}
