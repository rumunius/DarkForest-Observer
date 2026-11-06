import type {OperationResult} from '@darkforest/contracts';
import {requireThat} from '../storage/store';
import {completed} from './engine';
import {autoFinish, eliminate, logEvent, retire} from './life';
import type {PlayerActionContext} from './player_action_context';
/** 记录本人离开母星的首航准备确认。 */
export function confirmPreflightDeparture(
  context: PlayerActionContext,
): OperationResult {
  const {db, now, actor, id} = context;
  db.exec('UPDATE flights SET departed=? WHERE player_id=?', now, actor.id);
  const result = completed(id, '已确认离开母星');
  return result;
}

/** 记录首航准备完成，仍等待统一发码。 */
export function stagePreflight(context: PlayerActionContext): OperationResult {
  const {db, now, actor, id} = context;
  db.exec(
    "UPDATE flights SET status='staged',staged=? WHERE player_id=?",
    now,
    actor.id,
  );
  const result = completed(id, '准备完成', '等待统一发码。');
  return result;
}

/** 领取首航待激活配置，发码不授予攻防资格。 */
export function issuePreflightCode(
  context: PlayerActionContext,
): OperationResult {
  const {engine, actor, id, prepared, db} = context;
  engine.issue(actor.id, id, prepared);
  db.exec("UPDATE flights SET status='outfitting' WHERE player_id=?", actor.id);
  const result = completed(id, '配置已领取', '请在安全位置按图示佩戴手环。');
  return result;
}

/** 保存穿戴就绪，实际激活仍由统一开赛事件处理。 */
export function confirmPreflightReadiness(
  context: PlayerActionContext,
): OperationResult {
  const {db, now, actor, id} = context;
  db.exec(
    "UPDATE flights SET status='ready',ready=? WHERE player_id=?",
    now,
    actor.id,
  );
  const result = completed(id, '穿戴就绪', '等待统一开赛。');
  return result;
}

/** 确认本次返航，继续沿用原重生截止时间。 */
export function confirmReturn(context: PlayerActionContext): OperationResult {
  const {db, actor, id} = context;
  db.exec("UPDATE flights SET status='preparing' WHERE player_id=?", actor.id);
  const result = completed(id, '已确认返航', '离开母星50米后领取新配置。');
  return result;
}

/** 领取永久唯一的新配置，保持尚未激活状态。 */
export function issueRespawnCode(
  context: PlayerActionContext,
): OperationResult {
  const {engine, actor, id, prepared, db} = context;
  engine.issue(actor.id, id, prepared);
  db.exec("UPDATE flights SET status='issued' WHERE player_id=?", actor.id);
  const result = completed(id, '新配置已领取', '请在安全位置按图示佩戴手环。');
  return result;
}

/** 激活预留配置并取消原返航超时事件，保存出航事实。 */
export function launchRespawn(context: PlayerActionContext): OperationResult {
  const {flight, db, now, game, actor, engine, eventId, id} = context;
  requireThat(
    flight.code_id &&
      db.all<Record<string, SqlStorageValue>>(
        "UPDATE sighting_codes SET status='active',activated_utc=?,activated_game=? WHERE id=? AND status='reserved' RETURNING id",
        now,
        game,
        flight.code_id,
      ).length === 1,
    'CODE_NOT_RESERVED',
    '请重新核对当前配置。',
  );
  db.exec(
    "UPDATE flights SET status='active',deadline=NULL WHERE player_id=?",
    actor.id,
  );
  db.exec(
    "UPDATE scheduled_events SET status='cancelled' WHERE kind='respawn_timeout' AND status='pending' AND json_extract(payload,'$.player')=?",
    actor.id,
  );
  logEvent(
    engine,
    eventId,
    'respawn',
    '完成出航',
    `${engine.identity(actor.id)}已完成出航。`,
    'personal',
    [actor.id],
    game,
    now,
    actor.id,
  );
  const result = completed(id, '已完成出航');
  return result;
}

/** 按是否已开赛处理退出，并在本次结算末尾检查提前完赛。 */
export function withdrawPlayer(context: PlayerActionContext): OperationResult {
  const {matchState, engine, actor, eventId, game, now, db, id} = context;
  if (matchState.start_settled) {
    eliminate(engine, actor.id, 'withdrawn', eventId, game, now);
  } else {
    retire(engine, actor.id, 'withdrawn', game, now);
    db.exec("UPDATE players SET entry_status='withdrawn' WHERE id=?", actor.id);
    db.exec('DELETE FROM roster_members WHERE player_id=?', actor.id);
  }
  const result = completed(id, '已退出比赛');
  autoFinish(engine, game, now, eventId);
  return result;
}
