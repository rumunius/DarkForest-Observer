import {integer, parseJson} from '../../../../packages/contracts/src/backend';
import {requireThat} from '../storage/store';
import type {MatchControlContext} from './match_control_context';

/** 按清理代次裁剪完赛秘密与通知，保留成绩所需的最小战报字段。 */
export function eraseMatchSecrets(context: MatchControlContext): unknown {
  const {db, payload} = context;
  requireThat(
    db.match().phase === 'ended',
    'ENDED_REQUIRED',
    '进行中的比赛不能清理。',
  );
  const generation = integer(payload.generation, 1);
  const identity = db.one<{erasure_generation: number}>(
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
      if (table === 'notice_queue') {
        db.exec('DELETE FROM notice_actions');
      }
      db.exec(`DELETE FROM ${table}`);
    }
    db.exec("UPDATE sighting_codes SET ciphertext=''");
    db.exec('UPDATE attacks SET before_json=NULL');
    db.exec(
      "UPDATE scheduled_events SET payload='{}',status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END",
    );
    for (const row of db.all<{version: number; snapshot_json: string}>(
      'SELECT version,snapshot_json FROM result_reports WHERE snapshot_json IS NOT NULL',
    )) {
      const standings = (
        parseJson(row.snapshot_json) as Array<Record<string, unknown>>
      ).map(
        ({
          id,
          nickname,
          rank,
          tied,
          kills,
          eliminatedAt,
          eliminationReason,
        }) => ({
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
  return {
    erasureGeneration: generation,
    scope: 'nonessential-secrets',
    verified: true,
  };
}
