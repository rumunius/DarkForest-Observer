import type {OperationResult} from '@darkforest/contracts';
import {coordinate} from '../../../../packages/contracts/src/backend';
import {
  broadcastCopy,
  clearingCopy,
  reverseListeningCopy,
} from '../../../../packages/contracts/src/message_copy';
import {firstSongDue, uniformInt} from '../domain/rules';
import {requireThat} from '../storage/store';
import {completed} from './engine';
import {autoFinish, destroyHome, logEvent} from './life';
import type {PlayerActionContext} from './player_action_context';

/** 原子登记正式广播、扣额及秘密歌者计划，按原范围授予反向情报。 */
export function publishBroadcast(
  context: PlayerActionContext,
): OperationResult {
  const {raw, db, game, engine, eventId, actor, now, home, id, playerState} =
    context;
  const code = coordinate(raw.code);
  requireThat(
    !db.one<Record<string, SqlStorageValue>>(
      'SELECT id FROM broadcasts WHERE code=?',
      code,
    ),
    'ALREADY_BROADCAST',
    '这个坐标已经正式广播。',
  );
  const probability = db.parameters().singerPercent;
  const songDue = firstSongDue(game, uniformInt, probability);
  logEvent(
    engine,
    eventId,
    'broadcast',
    '坐标广播',
    broadcastCopy(engine.identity(actor.id), code),
    'public',
    [actor.id],
    game,
    now,
    null,
    code,
    actor.id,
  );
  db.exec(
    'INSERT INTO broadcasts VALUES(?,?,?,?,?)',
    eventId,
    actor.id,
    code,
    songDue,
    songDue === null ? 'not_selected' : 'pending',
  );
  db.exec('UPDATE players SET broadcasts=broadcasts+1 WHERE id=?', actor.id);
  if (songDue !== null) {
    engine.schedule(`song:${eventId}`, 'song_visit', 'game', songDue, 2, {
      code,
      broadcast: eventId,
    });
  }
  const target = db.officialHome(code);
  if (target && home) {
    db.exec(
      'INSERT INTO intel_grants VALUES(?,?,?,?,?,?)',
      `${eventId}:reverse`,
      target.player_id,
      actor.id,
      home.code,
      eventId,
      game,
    );
    engine.notice(
      eventId,
      target.player_id,
      '你被广播了',
      reverseListeningCopy(
        engine.identity(target.player_id),
        code,
        engine.identity(actor.id),
        home.code,
      ),
      game,
    );
  }
  engine.notice(
    eventId,
    'group',
    '坐标广播',
    broadcastCopy(engine.identity(actor.id), code),
    game,
  );
  const result = completed(id, '广播已发布', `坐标${code}已暴露给全宇宙。`, {
    outcome: {
      accepted: true,
      eventId,
      remaining: 1 - playerState.broadcasts,
    },
  });
  return result;
}

/** 扣除光粒并按真实母星毁灭结果记录公开事件，随后检查提前完赛。 */
export function firePhoton(context: PlayerActionContext): OperationResult {
  const {raw, db, engine, eventId, game, now, actor, id} = context;
  const code = coordinate(raw.code);
  const target = db.officialHome(code, true);
  const hit = target
    ? destroyHome(engine, target.player_id, eventId, game, now)
    : false;
  const body = clearingCopy(
    'photon',
    code,
    hit ? engine.identity(target!.player_id) : undefined,
  );
  const title = hit ? '光粒命中' : '光粒清理';
  logEvent(
    engine,
    eventId,
    'photon',
    title,
    body,
    'public',
    hit ? [target!.player_id] : [],
    game,
    now,
    null,
    code,
    actor.id,
  );
  db.exec(
    'INSERT INTO photon_shots VALUES(?,?,?,?)',
    eventId,
    actor.id,
    code,
    hit ? target!.player_id : null,
  );
  db.exec('UPDATE players SET photons=0 WHERE id=?', actor.id);
  engine.notice(eventId, 'group', title, body, game);
  const result = completed(id, '光粒已发射', body, {
    outcome: {accepted: true, eventId, remaining: 0},
  });
  autoFinish(engine, game, now, eventId);
  return result;
}
