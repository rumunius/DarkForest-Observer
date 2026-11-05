import { text } from '../../../../packages/contracts/src/backend';
import { requireThat, type CodeRow } from '../storage/store';
import type { Engine, PreparedCode } from './engine';
import { retire, logEvent } from './life';
export type AttackRow = {
  id: string;
  actor: string;
  target: string | null;
  code_id: string | null;
  request_id: string;
  classification: string;
  roll: number | null;
  wrong_index: number | null;
  edge_utc: number;
  committed_utc: number;
  game_ms: number;
  valid: number;
  before_json: string | null;
};
export function correctionTarget(e: Engine, raw: unknown): AttackRow {
  const id = text(raw, 180),
    attack = e.db.one<AttackRow>('SELECT * FROM attacks WHERE id=?', id);
  requireThat(
    attack?.valid &&
      attack.before_json &&
      ['hit', 'unknown_code', 'reserved_code'].includes(attack.classification),
    'ATTACK_NOT_CORRECTABLE',
    '请选择一条有效的攻击记录。',
  );
  requireThat(
    e.db.match().paused_at !== null && e.db.match().phase !== 'ended',
    'PAUSE_REQUIRED',
    '请先暂停比赛。',
  );
  const later = e.db.one(
    'SELECT id FROM attacks WHERE actor=? AND valid=1 AND (committed_utc>? OR (committed_utc=? AND rowid>(SELECT rowid FROM attacks WHERE id=?)))',
    attack.actor,
    attack.committed_utc,
    attack.committed_utc,
    attack.id,
  );
  requireThat(!later, 'LATER_ATTACK_EXISTS', '该文明已有后续攻击，请先复核后续记录。');
  const restored =
    attack.classification === 'hit'
      ? attack.target
      : e.db.flight(attack.actor).status === 'eliminated'
        ? attack.actor
        : null;
  if (restored) {
    const flight = e.db.flight(restored),
      before = JSON.parse(attack.before_json) as { actorVoyage: number };
    const voyage = attack.target
      ? e.db.one<CodeRow>('SELECT * FROM sighting_codes WHERE id=?', attack.code_id!)!.voyage
      : before.actorVoyage;
    requireThat(
      flight.voyage === voyage && ['returning', 'preparing', 'eliminated'].includes(flight.status),
      'CORRECTION_DEPENDENCY',
      '相关文明已进入后续航次，请核对航次与事件后更正。',
    );
    const out = e.db.one<{ source: string }>(
      'SELECT source FROM eliminations WHERE player_id=? AND valid=1',
      restored,
    );
    requireThat(
      !out || out.source === `action:${attack.actor}:${attack.request_id}`,
      'CORRECTION_DEPENDENCY',
      '相关文明还有其他淘汰原因，请先核对淘汰记录。',
    );
  }
  return attack;
}
export function correctAttack(
  e: Engine,
  id: string,
  actor: string,
  attack: AttackRow,
  reason: string,
  prepared: PreparedCode[],
): void {
  const db = e.db,
    before = JSON.parse(attack.before_json!) as {
      wrong: number;
      lockedUntil: number;
      actorHomeDestroyed: number | null;
      actorHomeSource: string | null;
    };
  const source = `action:${attack.actor}:${attack.request_id}`,
    game = e.game(),
    now = e.now();
  const restored =
    attack.classification === 'hit'
      ? attack.target
      : db.flight(attack.actor).status === 'eliminated'
        ? attack.actor
        : null;
  const stateBefore = {
    actor: db.player(attack.actor),
    flight: db.flight(attack.actor),
    target: attack.target ? db.flight(attack.target) : null,
  };
  db.exec('UPDATE attacks SET valid=0 WHERE id=? AND valid=1', attack.id);
  if (attack.wrong_index !== null) {
    db.exec(
      'UPDATE attack_controls SET wrong=?,locked_until=? WHERE player_id=?',
      before.wrong,
      before.lockedUntil,
      attack.actor,
    );
    const home = db.home(attack.actor);
    if (home?.source === source)
      db.exec(
        'UPDATE homeworlds SET destroyed_game=?,source=? WHERE player_id=?',
        before.actorHomeDestroyed,
        before.actorHomeSource,
        attack.actor,
      );
  }
  if (restored) {
    db.exec(
      'UPDATE eliminations SET valid=0 WHERE player_id=? AND source=? AND valid=1',
      restored,
      source,
    );
    retire(e, restored, 'attack_correction', game, now);
    e.issue(restored, `correction-${id}`, prepared);
    db.exec("UPDATE flights SET status='issued',deadline=NULL WHERE player_id=?", restored);
    db.exec(
      "UPDATE scheduled_events SET status='cancelled' WHERE kind='respawn_timeout' AND status='pending' AND json_extract(payload,'$.player')=?",
      restored,
    );
    e.notice(
      `correction:${id}`,
      restored,
      '攻击更正',
      '裁判已更正相关攻击。请按新配置佩戴手环，等待裁判核对后恢复出航。',
      game,
    );
  }
  db.exec(
    'INSERT INTO attack_corrections VALUES(?,?,?,?,?,?,?)',
    id,
    attack.id,
    actor,
    reason,
    now,
    JSON.stringify(stateBefore),
    JSON.stringify({
      actor: db.player(attack.actor),
      flight: db.flight(attack.actor),
      target: attack.target ? db.flight(attack.target) : null,
    }),
  );
  logEvent(
    e,
    `correction:${id}`,
    'review',
    '攻击更正',
    `${reason}。已发出的情报保留在事件记录中。`,
    'global',
    [attack.actor, ...(attack.target ? [attack.target] : [])],
    game,
    now,
  );
}
