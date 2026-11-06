import type { Engine } from '../services/engine';
import { exportData } from '../services/export';
import { events } from '../projections/snapshot';
import { results } from '../services/life';
import { requireThat, type Actor } from '../storage/store';
import { integer } from '../../../../packages/contracts/src/backend';

export async function historyRecord(e: Engine, actorId: string, payload: Record<string, unknown>) {
  const keys = await e.keys();
  const match = e.db.match();
  requireThat(!match.recovery_state, 'RECOVERY_LOCKED', '比赛正在恢复，请稍后再查看资料。');
  requireThat(match.phase === 'ended', 'ENDED_REQUIRED', '比赛结束后可以查看赛后资料。');
  const identity = e.db.one<{ kind: string; erasure_generation: number }>(
    'SELECT kind,erasure_generation FROM match_identity',
  );
  requireThat(identity, 'MATCH_NOT_AVAILABLE', '本场比赛尚未接入赛事中心。');
  const { kind } = payload;
  requireThat(
    payload.organizer === true ||
      ((kind === 'versions' || kind === 'report' || kind === 'replay') &&
        (e.db.one('SELECT account_id FROM participation_history WHERE account_id=?', actorId) ||
          e.db.one(
            "SELECT account_id FROM memberships WHERE account_id=? AND state='bound' AND local_id='J01'",
            actorId,
          ))),
    'FORBIDDEN',
    '当前账号不能查看这项赛后资料。',
    403,
  );
  if (kind === 'versions')
    return {
      versions: e.db.all(
        'SELECT version,created_utc,correction_reason FROM result_reports ORDER BY version DESC',
      ),
      erasureGeneration: identity.erasure_generation,
    };
  const actor: Actor = {
    id: actorId,
    match_id: e.matchId,
    role: 'judge',
    name: '赛事中心',
    permissions: '["system"]',
    credential_hash: '',
    enabled: 1,
    version: 1,
  };
  const common = {
    matchId: match.id,
    matchKind: identity.kind,
    revision: match.revision,
    createdUtc: e.now(),
  };
  if (kind === 'audit')
    return {
      ...common,
      audit: e.db.all('SELECT * FROM audit_logs ORDER BY seq'),
      identities: e.db.all('SELECT * FROM audit_identities ORDER BY seq'),
      commands: e.db.all('SELECT * FROM judge_command_log ORDER BY seq'),
    };
  if (kind === 'replay' || kind === 'backup')
    requireThat(
      identity.erasure_generation === 0,
      'REPLAY_EXPIRED',
      '本场完整复盘和备份已停止提供，请查看战报。',
      410,
    );
  if (kind === 'backup') return exportData(e, actor, 'backup', keys, { omitSessionData: true });
  requireThat(kind === 'report' || kind === 'replay', 'BAD_EXPORT', '请选择可用的赛后资料。', 400);
  const report = results(
    e,
    keys,
    payload.version === undefined ? undefined : integer(payload.version, 1),
  );
  requireThat(report, 'REPORT_NOT_FOUND', '这个战报版本不存在。', 404);
  if (kind === 'replay')
    return {
      ...common,
      report,
      events: events(e, actor, true, Number.MAX_SAFE_INTEGER, 100000),
      parameters: e.db.parameters(),
    };
  return {
    ...common,
    report: {
      ...report,
      standings: report.standings.map(
        ({ id, nickname, rank, tied, kills, eliminatedAt, eliminationReason }) => ({
          id,
          nickname,
          rank,
          tied,
          kills,
          eliminatedAt,
          eliminationReason,
        }),
      ),
    },
  };
}
