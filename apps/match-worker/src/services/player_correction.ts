import {parseJson} from '../../../../packages/contracts/src/backend';
import type {Engine, PreparedCode} from './engine';
import {requireThat, type FlightRow} from '../storage/store';
import {TIMES} from '../domain/rules';
import {retire} from './life';

/** 根据阶段和原航次计算恢复资格后的合法状态，不修改持久数据。 */
export function restoration(
  engine: Engine,
  target: string,
  intervention = false,
): {status: string; deadline: number | null} {
  const db = engine.db;
  const m = db.match();
  const p = db.player(target);
  requireThat(
    m.paused_at !== null &&
      ['forest', 'apocalypse', 'transfer', 'hunt'].includes(m.phase),
    'RESTORE_REQUIRES_REVIEW',
    '请在比赛暂停后核对淘汰记录，完赛后的争议使用战报更正。',
  );
  requireThat(
    db.roster().includes(target) &&
      p.entry_status === 'registered' &&
      db.flight(target).status === 'eliminated',
    'TARGET_NOT_ELIMINATED',
    '请选择本场正式名单中已永久淘汰的文明。',
  );
  const out = db.one<{source: string; reason: string}>(
    'SELECT source,reason FROM eliminations WHERE player_id=? AND valid=1',
    target,
  )!;
  if (intervention) {
    requireThat(out, 'RESTORE_EVIDENCE_MISSING', '未找到当前有效淘汰记录。');
    return {status: 'issued', deadline: null};
  }
  const manual = db.one<{before_json: string}>(
    'SELECT before_json FROM judge_eliminations WHERE source=? AND player_id=?',
    out.source,
    target,
  );
  if (manual) {
    const prior = parseJson(manual.before_json) as FlightRow;
    if (prior.status === 'active') {
      return {status: 'issued', deadline: null};
    }
    requireThat(
      m.phase === 'forest' &&
        db.home(target)?.destroyed_game === null &&
        prior.deadline !== null &&
        engine.game() < Math.min(prior.deadline, TIMES.apocalypse),
      'RESTORE_DEADLINE_EXPIRED',
      '原重生期限或母星资格已失效，请先核对关联事件。',
    );
    return {
      status: prior.status === 'returning' ? 'returning' : 'preparing',
      deadline: prior.deadline,
    };
  }
  // Earlier schemas did not retain a manual snapshot. These terminal-stage reasons
  // apply to already launched ships; require their matching retired voyage as evidence.
  if (
    [
      'no_share_at_cutoff',
      'outside_at_cutoff',
      'left_zone',
      'sharing_stopped',
      'location_violation',
    ].includes(out.reason)
  ) {
    requireThat(
      db.one<Record<string, SqlStorageValue>>(
        'SELECT id FROM sighting_codes WHERE player_id=? AND voyage=? AND activated_game IS NOT NULL AND retired_reason=?',
        target,
        db.flight(target).voyage,
        out.reason,
      ),
      'RESTORE_EVIDENCE_MISSING',
      '旧淘汰记录缺少相符的已出航配置，请先核对航次证据。',
    );
    return {status: 'issued', deadline: null};
  }
  requireThat(
    m.phase === 'forest' && db.home(target)?.destroyed_game === null,
    'RESTORE_REQUIRES_REVIEW',
    '跨阶段恢复须关联人工淘汰记录；攻击判罚请使用攻击更正。',
  );
  return {
    status: 'preparing',
    deadline: Math.min(
      engine.game() + db.parameters().respawnSeconds * 1000,
      TIMES.apocalypse,
    ),
  };
}

/** 恢复文明资格并处理新码、观战撤销及通知，保留已传播信息的审计。 */
export function restorePlayer(
  engine: Engine,
  target: string,
  id: string,
  source: string,
  prepared: PreparedCode[],
  intervention = false,
): void {
  const next = restoration(engine, target, intervention);
  const db = engine.db;
  retire(engine, target, 'judge_restoration', engine.game(), engine.now());
  db.exec(
    'UPDATE eliminations SET valid=0 WHERE player_id=? AND valid=1',
    target,
  );
  db.exec(
    "UPDATE scheduled_events SET status='cancelled' WHERE kind='respawn_timeout' AND status='pending' AND json_extract(payload,'$.player')=?",
    target,
  );
  db.exec(
    'UPDATE flights SET status=?,deadline=? WHERE player_id=?',
    next.status,
    next.deadline,
    target,
  );
  if (next.status === 'issued') {
    engine.issue(target, `restore-${id}`, prepared);
  }
  if (next.deadline !== null) {
    engine.schedule(
      `${source}:timeout`,
      'respawn_timeout',
      'game',
      next.deadline,
      1,
      {
        player: target,
        deadline: next.deadline,
      },
    );
  }
  engine.notice(
    source,
    target,
    '参赛资格更正',
    next.status === 'issued'
      ? '裁判已恢复你的参赛资格。请在安全位置按新配置佩戴手环，等待裁判确认后继续出航。'
      : '裁判已恢复你的参赛资格，请打开本人官网继续返航或重生。',
  );
}
