import {scalarText} from '../../../../packages/contracts/src/backend';
import {Fault} from '../storage/store';
import type {Engine} from './engine';

import {
  attackCorrectionImpact,
  correctionImpact,
  effectImpact,
  equipmentImpact,
  observerImpact,
} from './management_civilization_impact';
import {
  eliminationImpact,
  restorationImpact,
  type Impact,
  type ManagementImpactContext,
} from './management_impact_context';
import {
  accountImpact,
  announcementImpact,
  replayImpact,
  reportImpact,
  statisticImpact,
} from './management_records_impact';
import {
  armingImpact,
  eventControlImpact,
  eventTriggerImpact,
  recoveryImpact,
  schedulerImpact,
  withdrawalImpact,
} from './management_schedule_impact';
/** 根据权威状态计算管理前后变化及副作用说明，执行时仍需重新校验。 */
export function managementImpact(
  engine: Engine,
  path: string,
  body: Record<string, unknown>,
): Impact {
  const db = engine.db;
  const matchState = db.match();
  const target = scalarText(body.target ?? matchState.id);
  const changes: Impact['changes'] = [];
  const consequences: string[] = [];
  const context: ManagementImpactContext = {
    engine,
    db,
    matchState,
    target,
    body,
    changes,
    consequences,
  };
  if (path === '/judge/correction') {
    correctionImpact(context);
  } else if (path === '/judge/player-restore') {
    restorationImpact(context, target);
  } else if (
    path === '/judge/player-eliminate' ||
    path === '/judge/hunt-eliminate'
  ) {
    eliminationImpact(context, [target]);
  } else if (path === '/judge/equipment-correction') {
    equipmentImpact(context);
  } else if (path === '/judge/attack-correction') {
    attackCorrectionImpact(context);
  } else if (path === '/judge/accounts') {
    accountImpact(context);
  } else if (path === '/judge/event-control') {
    eventControlImpact(context);
  } else if (path === '/judge/event-trigger') {
    eventTriggerImpact(context);
  } else if (path === '/judge/effects') {
    effectImpact(context);
  } else if (path === '/judge/observer-access') {
    observerImpact(context);
  } else if (
    path === '/judge/arm-code-release' ||
    path === '/judge/arm-start'
  ) {
    armingImpact(context, path);
  } else if (path.startsWith('/judge/roster/')) {
    withdrawalImpact(context, path);
  } else if (
    path === '/judge/scheduler/rearm' ||
    path === '/judge/events/settle-due'
  ) {
    schedulerImpact(context, path);
  } else if (path === '/judge/recovery-finalize') {
    recoveryImpact(context);
  } else if (path === '/judge/report-correction') {
    reportImpact(context);
  } else if (path === '/judge/reveal') {
    statisticImpact(context);
  } else if (path === '/judge/replay') {
    replayImpact(context);
  } else if (
    ['/judge/announce', '/judge/schedule-announcement'].includes(path)
  ) {
    announcementImpact(context);
  } else {
    throw new Fault(
      501,
      'PREVIEW_NOT_IMPLEMENTED',
      '该操作的业务预览尚未实现，已阻止执行。',
    );
  }
  return {changes, consequences};
}

/** Restricted business audit. Authentication material and cryptographic code indexes are excluded. */
export function managementState(engine: Engine): Record<string, unknown> {
  const db = engine.db;
  return {
    match: db.one<Record<string, SqlStorageValue>>(
      'SELECT id,phase,revision,paused_at,paused_total,pause_reason,release_at,started_at,hunt_finalized,ended_game,ended_utc,finish_reason,recovery_state,site_json FROM matches',
    ),
    roster: db.roster(),
    players: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM players ORDER BY id',
    ),
    homes: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM homeworlds ORDER BY player_id',
    ),
    flights: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM flights ORDER BY player_id',
    ),
    codes: db.all<Record<string, SqlStorageValue>>(
      'SELECT id,player_id,voyage,status,issued_utc,activated_utc,activated_game,retired_utc,retired_game,retired_reason FROM sighting_codes ORDER BY issued_utc,id',
    ),
    eliminations: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM eliminations ORDER BY seq',
    ),
    attacks: db.all<Record<string, SqlStorageValue>>(
      'SELECT id,actor,target,classification,valid,wrong_index,game_ms FROM attacks ORDER BY rowid',
    ),
    controls: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM attack_controls ORDER BY player_id',
    ),
    scheduled: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM scheduled_events ORDER BY id',
    ),
    effects: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM admin_effects ORDER BY id',
    ),
    notices: db.all<Record<string, SqlStorageValue>>(
      'SELECT id,target,status,version,copied_by,copied_utc,sent_by,sent_utc,error FROM notice_queue ORDER BY ordering_seq',
    ),
    accounts: db.all<Record<string, SqlStorageValue>>(
      'SELECT id,role,enabled,version,permissions FROM accounts ORDER BY id',
    ),
    sessions: db.all<Record<string, SqlStorageValue>>(
      'SELECT account_id,COUNT(*) AS active FROM sessions WHERE revoked=0 AND expires>? GROUP BY account_id',
      engine.now(),
    ),
    parameters: db.parameters(),
    reports: db.all<Record<string, SqlStorageValue>>(
      'SELECT version,reason,correction_reason FROM result_reports ORDER BY version',
    ),
  };
}
