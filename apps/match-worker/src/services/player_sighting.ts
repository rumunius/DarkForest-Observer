import type {OperationResult} from '@darkforest/contracts';
import {
  gameTimeCopy,
  messageDuration,
  shipDestroyedCopy,
} from '../../../../packages/contracts/src/message_copy';
import {normalizeArms, TIMES, uniformInt} from '../domain/rules';
import {requireThat, type CodeRow, type Parameters} from '../storage/store';
import {completed} from './engine';
import {autoFinish, eliminate, logEvent} from './life';
import type {PlayerActionContext} from './player_action_context';

interface SightingControl {
  last_at: number | null;
  attempts: number;
  wrong: number;
  locked_until: number;
}
interface SightingPenalty {
  wrong: number;
  locked: number;
  roll: number | null;
}
interface SightingOutcome extends SightingPenalty {
  classification: string;
  target: string | null;
}
interface SightingBefore {
  wrong: number;
  lockedUntil: number;
  actorHomeDestroyed: number | null;
  actorHomeSource: string | null;
  actorVoyage: number;
}

/** 在入口事务内结算目击、竞速及失配，沿用同一时间与状态快照。 */
export function resolveSighting(context: PlayerActionContext): OperationResult {
  const {
    db,
    actor,
    now,
    raw,
    keys,
    home,
    flight,
    edgeUtc,
    game,
    engine,
    eventId,
  } = context;
  const params = db.parameters();
  const control = db.one<SightingControl>(
    'SELECT * FROM attack_controls WHERE player_id=?',
    actor.id,
  )!;
  const count = db.one<{count: number}>(
    'SELECT COUNT(*) AS count FROM attacks WHERE actor=? AND committed_utc>?',
    actor.id,
    now - 60_000,
  )!.count;
  requireThat(
    (control.last_at === null ||
      now - control.last_at >= params.sightingIntervalMs) &&
      count < params.sightingsPerMinute,
    'SIGHTING_THROTTLED',
    '提交过于频繁，请稍后再试。',
    429,
  );
  const key = normalizeArms(raw.arm_a, raw.arm_b);
  const attempted = keys.codes.find(c => c.key === key)!;
  const code = db.one<CodeRow>(
    'SELECT * FROM sighting_codes WHERE mac=?',
    attempted.mac,
  );
  const before = {
    wrong: control.wrong,
    lockedUntil: control.locked_until,
    actorHomeDestroyed: home?.destroyed_game ?? null,
    actorHomeSource: home?.source ?? null,
    actorVoyage: flight.voyage,
  };
  let classification = !code
    ? 'unknown_code'
    : code.player_id === actor.id
      ? 'self_code'
      : code.status === 'retired'
        ? 'retired_code'
        : code.status === 'reserved'
          ? 'reserved_code'
          : 'hit';
  let roll: number | null = null;
  let wrong = control.wrong;
  let locked = control.locked_until;
  let target: string | null = null;
  if (
    classification === 'retired_code' &&
    code &&
    code.retired_reason === 'hit' &&
    code.activated_utc !== null &&
    code.retired_utc !== null &&
    edgeUtc >= code.activated_utc &&
    edgeUtc <= code.retired_utc &&
    code.retired_utc - edgeUtc <= 500 &&
    db.one<Record<string, SqlStorageValue>>(
      "SELECT id FROM attacks WHERE code_id=? AND classification='hit' AND valid=1",
      code.id,
    )
  ) {
    classification = 'lost_race';
  }
  if (classification === 'hit' && code) {
    target = applySightingHit(context, code, params);
  } else if (['reserved_code', 'unknown_code'].includes(classification)) {
    ({wrong, locked, roll} = applySightingPenalty(context, params, {
      wrong,
      locked,
      roll,
    }));
  }
  const outcome: SightingOutcome = {
    classification,
    target,
    wrong,
    locked,
    roll,
  };
  recordSightingOutcome(context, code, control, before, outcome);
  const result = recordSightingFeedback(context, params, control, outcome);
  autoFinish(engine, game, now, eventId);
  return result;
}

/** Consume the active target code before granting intel or notifying either player. */
function applySightingHit(
  context: PlayerActionContext,
  code: CodeRow,
  params: Parameters,
): string {
  const {db, actor, matchState, game, now, engine, eventId} = context;
  const target = code.player_id;
  const targetFlight = db.flight(target);
  const targetHome = db.home(target);
  requireThat(
    targetFlight.status === 'active' &&
      targetFlight.code_id === code.id &&
      db.player(target).entry_status === 'registered',
    'TARGET_STATE_CONFLICT',
    '请稍后重试。',
  );
  const canRespawn =
    matchState.phase === 'forest' &&
    targetHome?.status === 'verified' &&
    targetHome.destroyed_game === null;
  requireThat(
    db.all<Record<string, SqlStorageValue>>(
      "UPDATE flights SET status=?,code_id=NULL,deadline=? WHERE player_id=? AND status='active' AND code_id=? RETURNING player_id",
      canRespawn ? 'returning' : 'active',
      canRespawn ? game + params.respawnSeconds * 1000 : null,
      target,
      code.id,
    ).length === 1,
    'TARGET_STATE_CONFLICT',
    '请稍后重试。',
  );
  requireThat(
    db.all<Record<string, SqlStorageValue>>(
      "UPDATE sighting_codes SET status='retired',retired_game=?,retired_utc=?,retired_reason='hit' WHERE id=? AND status='active' RETURNING id",
      game,
      now,
      code.id,
    ).length === 1,
    'TARGET_STATE_CONFLICT',
    '请稍后重试。',
  );
  if (canRespawn) {
    engine.schedule(
      `respawn:${target}:${code.id}`,
      'respawn_timeout',
      'game',
      game + params.respawnSeconds * 1000,
      1,
      {player: target, deadline: game + params.respawnSeconds * 1000},
    );
  } else {
    eliminate(engine, target, 'sighting', eventId, game, now);
  }
  if (targetHome) {
    db.exec(
      'INSERT OR IGNORE INTO intel_grants(id,owner,target,code,source,game_ms) VALUES(?,?,?,?,?,?)',
      `${eventId}:intel`,
      actor.id,
      target,
      targetHome.code,
      eventId,
      game,
    );
  }
  logEvent(
    engine,
    eventId,
    'sighting',
    '目击成功',
    `${engine.identity(actor.id)}击毁了${engine.identity(target)}的飞船。`,
    'personal',
    [actor.id, target],
    game,
    now,
    actor.id,
  );
  engine.notice(
    eventId,
    target,
    '飞船被击毁',
    shipDestroyedCopy(engine.identity(target)) +
      (canRespawn
        ? `\n请在比赛时间${gameTimeCopy(Math.min(game + params.respawnSeconds * 1000, TIMES.apocalypse))}前完成重生。`
        : ''),
    game,
  );
  return target;
}
/** Only unknown or reserved codes advance the wrong-code penalty sequence. */
function applySightingPenalty(
  context: PlayerActionContext,
  params: Parameters,
  penalty: SightingPenalty,
): SightingPenalty {
  const {home, db, game, eventId, actor, engine, now} = context;
  let {wrong, locked, roll} = penalty;
  wrong++;
  if (wrong === 2) {
    roll = uniformInt(100);
  }
  if (wrong >= 3 || (wrong === 2 && roll! < params.secondOutPercent)) {
    if (home?.destroyed_game === null) {
      db.exec(
        'UPDATE homeworlds SET destroyed_game=?,source=? WHERE player_id=?',
        game,
        eventId,
        actor.id,
      );
    }
    eliminate(engine, actor.id, 'wrong_attack_direct_out', eventId, game, now);
  } else {
    locked =
      now +
      (wrong === 1 ? params.firstLockSeconds : params.secondLockSeconds) * 1000;
  }
  return {wrong, locked, roll};
}
/** Keep the control update and correction receipt together in the caller's transaction. */
function recordSightingOutcome(
  context: PlayerActionContext,
  code: CodeRow | undefined,
  control: SightingControl,
  before: SightingBefore,
  outcome: SightingOutcome,
): void {
  const {db, now, actor, eventId, id, edgeUtc, game} = context;
  const {wrong, locked, target, classification, roll} = outcome;
  db.exec(
    'UPDATE attack_controls SET wrong=?,locked_until=?,last_at=?,attempts=attempts+1 WHERE player_id=?',
    wrong,
    locked,
    now,
    actor.id,
  );
  db.exec(
    'INSERT INTO attacks(id,actor,target,code_id,request_id,classification,roll,wrong_index,edge_utc,committed_utc,game_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    `${eventId}:attack`,
    actor.id,
    target,
    code?.id ?? null,
    id,
    classification,
    roll,
    wrong > control.wrong ? wrong : null,
    edgeUtc,
    now,
    game,
  );
  db.exec(
    'UPDATE attacks SET before_json=? WHERE id=?',
    JSON.stringify(before),
    `${eventId}:attack`,
  );
}
/** Emit only the decided outcome and return the actor's authorized response. */
function recordSightingFeedback(
  context: PlayerActionContext,
  params: Parameters,
  control: SightingControl,
  outcome: SightingOutcome,
): OperationResult {
  const {db, actor, engine, eventId, game, now, id} = context;
  const {wrong, locked, target} = outcome;
  const eliminated = db.flight(actor.id).status === 'eliminated';
  const mismatch = wrong > control.wrong;
  const missedTitle = mismatch
    ? eliminated
      ? '直接出局'
      : '禁止攻击'
    : '本次目击未产生击毁';
  const missedBody = mismatch
    ? eliminated
      ? `文明${engine.identity(actor.id)}，本次提交的手环颜色有误，你已永久淘汰。\n请在安全位置摘下全部比赛手环，返回中控室，查看官网上的宇宙观测开放时间。`
      : `文明${engine.identity(actor.id)}，本次提交的手环颜色有误。\n累计错误：${wrong}次。禁止目击攻击：${messageDuration((locked - now) / 1000)}。\n恢复攻击时间：${new Date(locked).toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})}。\n再次提交错误颜色的处罚：${wrong === 1 ? `${params.secondOutPercent}%概率永久淘汰，${100 - params.secondOutPercent}%概率禁止目击攻击${messageDuration(params.secondLockSeconds)}` : '永久淘汰'}。`
    : '本次目击未产生击毁。';
  if (!target) {
    logEvent(
      engine,
      eventId,
      'sighting',
      missedTitle,
      missedBody,
      'personal',
      [actor.id],
      game,
      now,
      actor.id,
    );
  } else {
    logEvent(
      engine,
      `${eventId}:target`,
      'sighting',
      '飞船被击毁',
      shipDestroyedCopy(engine.identity(target)),
      'personal',
      [target],
      game,
      now,
      target,
    );
  }
  if (control.attempts === 120) {
    engine.notice(
      `sighting-threshold:${actor.id}`,
      'J01',
      '目击提交次数提醒',
      `${engine.identity(actor.id)}本场已提交121次目击，请复核。`,
      game,
    );
  }
  const intel =
    target && db.home(target)
      ? {
          id: `${eventId}:intel`,
          civilization: target,
          nickname: db.player(target).nickname ?? '',
          code: db.home(target)!.code,
          gameMs: game,
          source: '击毁飞船',
        }
      : undefined;
  const result = completed(
    id,
    target ? '目击成功' : missedTitle,
    target
      ? '目标飞船已被击毁，母星情报已保存。'
      : missedBody.replace(`文明${engine.identity(actor.id)}，`, ''),
    {
      outcome: {
        wrongCount: wrong,
        lockedUntilUtcMs: locked,
        eliminated,
        ...(target ? {target} : {}),
        ...(intel ? {intel} : {}),
      },
    },
  );
  return result;
}
