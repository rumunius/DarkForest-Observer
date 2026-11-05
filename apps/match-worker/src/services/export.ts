import { permission, requireThat, type Actor } from '../storage/store';
import type { Engine } from './engine';
import { encrypt } from '../security/crypto';
import { events } from '../projections/snapshot';
import { results } from './life';
import { SCHEMA_VERSION } from '../storage/schema';
import { createCheckpoint } from './recovery';
export const BACKUP_TABLES = [
  'schema_meta',
  'matches',
  'accounts',
  'sessions',
  'players',
  'homeworlds',
  'sighting_codes',
  'flights',
  'attack_controls',
  'attacks',
  'intel_grants',
  'eliminations',
  'scheduled_events',
  'event_log',
  'broadcasts',
  'photon_shots',
  'notice_queue',
  'request_journal',
  'previews',
  'audit_logs',
  'clock_pauses',
  'scheduler_health',
  'admin_effects',
  'result_reports',
  'rate_limits',
  'settings',
  'roster_members',
  'attack_corrections',
  'recovery_log',
  'credential_deliveries',
  'notice_actions',
  'judge_eliminations',
] as const;
export async function exportData(
  e: Engine,
  actor: Actor,
  kind: string,
  keys: Awaited<ReturnType<Engine['keys']>>,
): Promise<{ fileName: string; text: string }> {
  permission(
    actor,
    kind === 'backup' || kind === 'checkpoint' ? 'system' : kind === 'audit' ? 'audit' : 'results',
  );
  const now = e.now(),
    match = e.db.match();
  if (kind === 'checkpoint')
    return {
      fileName: `${match.id}-${now}-恢复检查点.json`,
      text: JSON.stringify(await createCheckpoint(e), null, 2),
    };
  if (kind === 'backup') {
    requireThat(
      match.phase === 'setup' || match.phase === 'ended' || match.paused_at !== null,
      'PAUSE_REQUIRED',
      '请先暂停比赛。',
    );
    const snapshot = e.db.tx(() =>
      Object.fromEntries(BACKUP_TABLES.map((table) => [table, e.db.all(`SELECT * FROM ${table}`)])),
    );
    const bookmark = await e.db.storage.getCurrentBookmark();
    const envelope = {
      format: 'darkforest-backup-v1',
      matchId: match.id,
      schemaVersion: SCHEMA_VERSION,
      revision: match.revision,
      createdUtc: now,
      bookmark,
      ciphertext: await encrypt(
        keys.encryption,
        JSON.stringify(snapshot),
        `backup|${match.id}|${now}`,
      ),
    };
    e.audit(actor.id, 'export_backup', match.id, '导出加密备份', { revision: match.revision });
    return {
      fileName: `${match.id}-${now}-加密备份.json`,
      text: JSON.stringify(envelope, null, 2),
    };
  }
  if (kind === 'audit')
    return {
      fileName: '裁判操作记录.json',
      text: JSON.stringify(
        e.db.all(
          'SELECT id,actor,action,target,reason,utc_ms,game_ms,detail FROM audit_logs ORDER BY seq',
        ),
        null,
        2,
      ),
    };
  requireThat(
    kind === 'report' && match.phase === 'ended',
    'RESULTS_NOT_READY',
    '比赛结束后可导出正式战报。',
  );
  const report = results(e, keys)!;
  return {
    fileName: '正式战报.json',
    text: JSON.stringify(
      {
        version: report.version,
        reason: report.reason,
        champions: report.champions,
        standings: report.standings.map((p) => ({
          id: p.id,
          nickname: p.nickname,
          rank: p.rank,
          tied: p.tied,
          kills: p.kills,
          eliminatedAt: p.eliminatedAt,
          eliminationReason: p.eliminationReason,
        })),
        events: events(e, actor, false, Number.MAX_SAFE_INTEGER, 100000)
          .filter((event) => event.audience === 'public')
          .map(({ actor: eventActor, ...event }) => ({
            ...event,
            ...(event.kind === 'broadcast' && eventActor ? { actor: eventActor } : {}),
          })),
      },
      null,
      2,
    ),
  };
}
