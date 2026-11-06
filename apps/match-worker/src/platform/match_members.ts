import {integer, text} from '../../../../packages/contracts/src/backend';
import type {MatchGrant} from '../rpc/types';
import {token} from '../security/crypto';
import type {Engine} from '../services/engine';
import {requireThat, type Actor} from '../storage/store';
import type {MatchControlContext} from './match_control_context';

/** 总裁判岗位持有的本场权限集合，平台身份本身不授予这些权限。 */
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

/** 把有效平台任职映射到本场账号；旧岗位和撤销成员不能复用映射。 */
export function membershipActor(engine: Engine, grant: MatchGrant): Actor {
  requireThat(
    grant.expires > engine.now() && grant.matchId === engine.matchId,
    'AUTHORIZATION_EXPIRED',
    '登录已过期，请重新登录。',
    401,
  );
  const member = engine.db.one<{
    local_id: string | null;
    epoch: number;
    state: string;
    kind: string;
  }>('SELECT * FROM memberships WHERE account_id=?', grant.accountId);
  const fence = engine.db.one<{auth_epoch: number; disabled: number}>(
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
  const actor = engine.db.one<Actor>(
    'SELECT * FROM accounts WHERE id=? AND enabled=1',
    member.local_id,
  );
  requireThat(
    actor && actor.version === member.epoch,
    'ASSIGNMENT_CHANGED',
    '本场身份已变更，请重新进入比赛。',
    403,
  );
  return actor;
}
function freezeCheck(engine: Engine) {
  requireThat(
    engine.db.match().phase === 'setup' &&
      !engine.db.one<Record<string, SqlStorageValue>>(
        "SELECT key FROM settings WHERE key='parameters_frozen'",
      ),
    'ROSTER_LOCKED',
    '首次锁定 T0 后不能新增、替换或绑定选手。',
  );
}
function bindCivilization(engine: Engine, accountId: string, name: string) {
  freezeCheck(engine);
  const db = engine.db;
  const used = new Set(
    db.all<{id: string}>('SELECT id FROM players').map(p => p.id),
  );
  let civilizationNumber = 1;
  while (
    civilizationNumber <= 350 &&
    used.has(`C${String(civilizationNumber).padStart(2, '0')}`)
  ) {
    civilizationNumber++;
  }
  requireThat(civilizationNumber <= 350, 'CAPACITY', '本场最多绑定350个文明。');
  const id = `C${String(civilizationNumber).padStart(2, '0')}`;
  db.exec(
    'INSERT INTO accounts(id,match_id,role,name,credential_hash,permissions) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,credential_hash=excluded.credential_hash,enabled=1,version=accounts.version+1',
    id,
    engine.matchId,
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
  return {accepted: true, localId: id};
}
function cancelManagement(engine: Engine, seat: string) {
  engine.db.exec(
    "UPDATE command_objects SET status='review',version=version+1 WHERE actor=? AND kind IN ('schedule','job','plan') AND status='pending'",
    seat,
  );
  engine.db.exec('DELETE FROM previews WHERE actor=?', seat);
  engine.db.exec('UPDATE sessions SET revoked=1 WHERE account_id=?', seat);
}
/** 登记本场邀请，玩家邀请仍受首次锁定T0后的冻结条件约束。 */
export function inviteMatchMember(context: MatchControlContext): unknown {
  const {payload, engine, db} = context;
  if (payload.kind === 'player') {
    freezeCheck(engine);
  }
  const account = text(payload.accountId, 100);
  requireThat(
    !db.one<Record<string, SqlStorageValue>>(
      'SELECT account_id FROM memberships WHERE account_id=?',
      account,
    ),
    'ALREADY_INVITED',
    '账号已在本场，请查看现有邀请。',
  );
  db.exec(
    'INSERT INTO memberships(account_id,kind,name,state) VALUES(?,?,?,?)',
    account,
    payload.kind as string,
    text(payload.name, 100),
    'invited',
  );
  return {invited: true};
}

/** 仅在未发布未冻结草稿中释放身份，失效任职并保留入口原请求收据。 */
export function removeMatchMember(context: MatchControlContext): unknown {
  const {db, engine, payload} = context;
  requireThat(
    db.one<Record<string, SqlStorageValue>>(
      'SELECT management_state FROM match_identity',
    )?.management_state === 'draft',
    'MATCH_ALREADY_PUBLISHED',
    '发布准备入口后不能移除本场成员。',
  );
  freezeCheck(engine);
  requireThat(
    db.match().revision === integer(payload.expectedRevision, 0),
    'VERSION_CONFLICT',
    '本场成员或状态已变化，请刷新后重新确认移除。',
  );
  const account = text(payload.accountId, 100);
  const member = db.one<{
    kind: string;
    local_id: string | null;
    name: string;
  }>('SELECT * FROM memberships WHERE account_id=?', account);
  requireThat(member, 'MEMBER_NOT_FOUND', '该账号已不在本场成员中。', 404);
  const localId = member.local_id;
  if (localId) {
    cancelManagement(engine, localId);
    db.exec(
      'UPDATE accounts SET enabled=0,version=version+1 WHERE id=?',
      localId,
    );
    if (member.kind === 'player') {
      db.exec('DELETE FROM roster_members WHERE player_id=?', localId);
      db.exec('DELETE FROM homeworlds WHERE player_id=?', localId);
      db.exec('DELETE FROM attack_controls WHERE player_id=?', localId);
      db.exec('DELETE FROM flights WHERE player_id=?', localId);
      db.exec('DELETE FROM players WHERE id=?', localId);
    } else {
      db.exec(
        'UPDATE staff_assignments SET ended_utc=? WHERE account_id=? AND ended_utc IS NULL',
        engine.now(),
        account,
      );
    }
  }
  db.exec('DELETE FROM memberships WHERE account_id=?', account);
  return {
    removed: true,
    accountId: account,
    name: member.name,
    releasedLocalId: localId,
  };
}

/** 确认同意后在同一事务接受邀请，玩家自动绑定且重试不重复分配。 */
export function acceptMatchInvitation(context: MatchControlContext): unknown {
  const {db, request, payload, engine} = context;
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
  requireThat(
    payload.consent === true,
    'CONSENT_REQUIRED',
    '请先确认活动说明与数据期限。',
    400,
  );
  if (member.state === 'bound') {
    return {accepted: true, localId: member.local_id};
  } else if (member.kind === 'player') {
    return bindCivilization(engine, request.actor, member.name);
  } else {
    if (member.state === 'invited') {
      db.exec(
        "UPDATE memberships SET state='accepted',epoch=epoch+1 WHERE account_id=?",
        request.actor,
      );
    }
    return {accepted: true};
  }
}

/** 为已接受的旧玩家邀请完成绑定，不绕过本场冻结条件。 */
export function bindAcceptedPlayer(context: MatchControlContext): unknown {
  const {engine, db, request} = context;
  freezeCheck(engine);
  const member = db.one<{kind: string; name: string; state: string}>(
    'SELECT * FROM memberships WHERE account_id=?',
    request.actor,
  );
  requireThat(
    member?.kind === 'player' && member.state === 'accepted',
    'ACCEPT_FIRST',
    '请先接受本场邀请。',
    403,
  );
  return bindCivilization(engine, request.actor, member.name);
}

/** 在本场事务内替换岗位、失效旧授权并登记新任职版本。 */
export function assignMatchSeat(context: MatchControlContext): unknown {
  const {payload, db, engine, request} = context;
  const account = text(payload.accountId, 100);
  const seat = text(payload.seat, 3);
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
    Number(payload.expectedVersion) === (current?.version ?? 0),
    'VERSION_CONFLICT',
    '席位已变化，请重新预览。',
  );
  db.exec(
    'UPDATE staff_assignments SET ended_utc=? WHERE seat_id=? AND ended_utc IS NULL',
    engine.now(),
    seat,
  );
  db.exec(
    "UPDATE memberships SET state='revoked',local_id=NULL,epoch=epoch+1 WHERE local_id=?",
    seat,
  );
  cancelManagement(engine, seat);
  const assignment = crypto.randomUUID();
  db.exec(
    'INSERT INTO accounts(id,match_id,role,name,credential_hash,permissions,version) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,credential_hash=excluded.credential_hash,permissions=excluded.permissions,enabled=1,version=excluded.version',
    seat,
    engine.matchId,
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
    engine.now(),
    epoch,
  );
  engine.notice(request.id, 'group', '设置了裁判', `裁判 ${seat} 已设置。`);
  return {seat, epoch, assignmentId: assignment};
}

/** 单调推进平台授权栅栏，停用时阻断该账号未执行管理任务。 */
export function applyAuthorizationFence(context: MatchControlContext): unknown {
  const {db, payload, engine} = context;
  db.exec(
    'INSERT INTO authorization_fences VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET auth_epoch=MAX(auth_epoch,excluded.auth_epoch),disabled=CASE WHEN excluded.auth_epoch>=auth_epoch THEN excluded.disabled ELSE disabled END',
    text(payload.accountId, 100),
    integer(payload.authEpoch, 1),
    payload.disabled === true ? 1 : 0,
  );
  const member = db.one<{local_id: string | null}>(
    'SELECT local_id FROM memberships WHERE account_id=?',
    payload.accountId as string,
  );
  if (payload.disabled && member?.local_id) {
    cancelManagement(engine, member.local_id);
  }
  return {fenced: true, authEpoch: payload.authEpoch};
}
