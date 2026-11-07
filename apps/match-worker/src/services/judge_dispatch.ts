import {coordinate} from '../../../../packages/contracts/src/backend';
import {settleDue} from '../scheduler/events';
import {updateAccount} from './accounts';
import {correctAttack, correctionTarget} from './attack_correction';
import type {JudgeMutationContext} from './judge_action_context';
import {
  armCodeRelease,
  armMatchStart,
  closePause,
  pauseMatch,
} from './judge_clock';
import {
  publishAnnouncement,
  publishStatistic,
  replayPublicEvents,
  scheduleAnnouncement,
} from './judge_messages';
import {
  correctEquipment,
  correctPlayerState,
  finalizeHunt,
  updateAttackRestriction,
} from './judge_player_actions';
import {replaceRoster, withdrawRosterMember} from './judge_setup';
import {validateParameters} from './judge_validation';
import {autoFinish, eliminate} from './life';
import {restorePlayer} from './player_correction';
import {finishRecovery} from './recovery';
import {correctReport} from './report_correction';

/** 在共同预览和权限检查后执行管理变更；版本、审计仍由入口统一收尾。 */
export function dispatchJudgeAction(
  context: JudgeMutationContext,
): string | undefined {
  const {
    path,
    engine,
    raw,
    reason,
    actor,
    credentialMaterial,
    id,
    prepared,
    db,
    source,
    game,
    now,
  } = context;
  let credentialDeliveryId: string | undefined;
  switch (path) {
    case '/judge/recovery-finalize':
      finishRecovery(engine);
      break;
    case '/judge/report-correction':
      correctReport(engine, raw, reason);
      break;
    case '/judge/accounts':
      credentialDeliveryId = updateAccount(
        engine,
        actor,
        raw,
        credentialMaterial,
      );
      break;
    case '/judge/arm-code-release':
      armCodeRelease(context);
      break;
    case '/judge/arm-start':
      armMatchStart(context);
      break;
    case '/judge/parameters':
      db.exec(
        "UPDATE settings SET value=?,version=version+1 WHERE key='parameters'",
        JSON.stringify(validateParameters(raw.values)),
      );
      break;
    case '/judge/attack-correction':
      correctAttack(
        engine,
        id,
        actor.id,
        correctionTarget(engine, raw.attack_id),
        reason,
        prepared,
      );
      break;
    case '/judge/event-control':
      if (raw.operation === 'cancel') {
        db.exec(
          "UPDATE scheduled_events SET status='cancelled' WHERE id=? AND status='pending'",
          String(raw.event_id),
        );
      } else {
        settleDue(engine);
      }
      break;
    case '/judge/event-trigger':
      engine.schedule(`${source}:manual-song`, 'song_visit', 'game', game, 2, {
        code: coordinate(raw.code),
        actor: actor.id,
      });
      settleDue(engine);
      break;
    case '/judge/schedule-announcement':
      scheduleAnnouncement(context);
      break;
    case '/judge/reveal':
      publishStatistic(context);
      break;
    case '/judge/replay':
      replayPublicEvents(context);
      break;
    case '/judge/roster':
      replaceRoster(context);
      break;
    case '/judge/pause':
      pauseMatch(context);
      break;
    case '/judge/resume':
      closePause(engine, now);
      break;
    case '/judge/hunt-finalize':
      finalizeHunt(context);
      break;
    case '/judge/hunt-eliminate':
      eliminate(
        engine,
        String(raw.target),
        String(raw.reason_code),
        source,
        game,
        now,
      );
      autoFinish(engine, game, now, source);
      break;
    case '/judge/player-eliminate':
      eliminate(
        engine,
        String(raw.target),
        'judge_violation',
        source,
        game,
        now,
      );
      autoFinish(engine, game, now, source);
      break;
    case '/judge/player-restore':
      restorePlayer(engine, String(raw.target), id, source, prepared);
      break;
    case '/judge/effects':
      updateAttackRestriction(context);
      break;
    case '/judge/announce':
      publishAnnouncement(context);
      break;
    case '/judge/scheduler/rearm':
      break;
    case '/judge/events/settle-due':
      settleDue(engine);
      break;
    case '/judge/observer-access':
      db.exec(
        'UPDATE players SET observer_revoked=? WHERE id=?',
        raw.allowed ? 0 : 1,
        String(raw.target),
      );
      break;
    case '/judge/equipment-correction':
      correctEquipment(context);
      break;
    case '/judge/correction':
      correctPlayerState(context);
      break;
    default:
      withdrawRosterMember(context);
      break;
  }
  return credentialDeliveryId;
}
