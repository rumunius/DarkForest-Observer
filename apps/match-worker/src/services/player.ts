import type {Action, OperationResult} from '@darkforest/contracts';
import {
  coordinate,
  homeworldSubmission,
  nickname,
  strict,
} from '../../../../packages/contracts/src/backend';
import {normalizeArms, TIMES} from '../domain/rules';
import {requireThat, type Actor} from '../storage/store';
import {type Engine, type PreparedCode} from './engine';
import type {PlayerActionContext} from './player_action_context';
import {dispatchPlayerAction} from './player_dispatch';

/** 计算当前玩家可用动作；页面显示只作提示，写接口必须重新判定。 */
export function allowedActions(engine: Engine, player: string): Action[] {
  if (engine.db.match().recovery_state) {
    return [];
  }
  const db = engine.db;
  const matchState = db.match();
  const playerState = db.player(player);
  const flight = db.flight(player);
  const homeworld = db.home(player);
  const now = engine.now();
  if (
    playerState.entry_status !== 'registered' ||
    flight.status === 'eliminated' ||
    matchState.phase === 'ended' ||
    matchState.paused_at !== null
  ) {
    return [];
  }
  const actions: Action[] = [];
  if (matchState.phase !== 'start_countdown') {
    actions.push('withdraw');
  }
  if (matchState.phase === 'setup') {
    if (!playerState.nickname) {
      return [...actions, 'nickname'];
    }
    if (flight.status === 'prelaunch') {
      if (homeworld?.status !== 'verified') {
        actions.push('homeworld-submit');
      } else if (flight.departed === null) {
        actions.push('preflight-depart');
      } else {
        actions.push('preflight-stage');
      }
    }
  }
  if (
    !db.one<Record<string, SqlStorageValue>>(
      'SELECT player_id FROM roster_members WHERE player_id=?',
      player,
    )
  ) {
    return matchState.phase === 'setup' ? actions : [];
  }
  if (matchState.phase === 'outfitting') {
    if (flight.status === 'staged') {
      actions.push('preflight-issue-code');
    }
    if (flight.status === 'outfitting') {
      actions.push('preflight-ready');
    }
  }
  if (flight.status === 'active') {
    const controls = db.one<{locked_until: number}>(
      'SELECT locked_until FROM attack_controls WHERE player_id=?',
      player,
    )!;
    const silent = db.one<Record<string, SqlStorageValue>>(
      'SELECT id FROM admin_effects WHERE active=1 AND starts<=? AND ends>? AND target IN (?,?)',
      now,
      now,
      '@a',
      player,
    );
    if (
      ['forest', 'apocalypse', 'hunt'].includes(matchState.phase) &&
      (matchState.phase !== 'hunt' || matchState.hunt_finalized !== null) &&
      controls.locked_until <= now &&
      !silent
    ) {
      actions.push('sighting');
    }
    if (matchState.phase === 'forest') {
      if (playerState.broadcasts < 2) {
        actions.push('broadcast');
      }
      if (playerState.tech && playerState.photons) {
        actions.push('photon');
      }
    }
  }
  if (
    matchState.phase === 'forest' &&
    homeworld?.status === 'verified' &&
    homeworld.destroyed_game === null &&
    flight.deadline !== null &&
    engine.game() < Math.min(flight.deadline, TIMES.apocalypse)
  ) {
    if (flight.status === 'returning') {
      actions.push('return-confirm');
    }
    if (flight.status === 'preparing') {
      actions.push('issue-code');
    }
    if (flight.status === 'issued') {
      actions.push('launch');
    }
  }
  return actions;
}
/** 在本场事务中执行玩家行动，复核身份、阶段、资源和目标合法性。 */
export function playerAction(
  engine: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  edgeUtc: number,
  keys: Awaited<ReturnType<Engine['keys']>>,
): OperationResult {
  requireThat(actor.role === 'player', 'FORBIDDEN', '请使用参赛账号。', 403);
  const action =
    path === '/player/nickname' ? 'nickname' : path.slice('/action/'.length);
  const db = engine.db;
  const now = engine.now();
  const game = engine.game(now);
  const matchState = db.match();
  const playerState = db.player(actor.id);
  const flight = db.flight(actor.id);
  const home = db.home(actor.id);
  // Format validation precedes eligibility, rate accounting, and random penalties.
  if (action === 'sighting') {
    strict(raw, ['request_id', 'arm_a', 'arm_b']);
    normalizeArms(raw.arm_a, raw.arm_b);
  } else if (action === 'homeworld-submit') {
    homeworldSubmission(raw);
  } else if (['broadcast', 'photon'].includes(action)) {
    strict(raw, ['request_id', 'code']);
    coordinate(raw.code);
  } else if (action === 'nickname') {
    strict(raw, ['request_id', 'nickname']);
    nickname(raw.nickname);
  } else {
    strict(raw, ['request_id']);
  }
  requireThat(
    allowedActions(engine, actor.id).includes(action as Action),
    'ACTION_UNAVAILABLE',
    '当前状态不能执行这项操作，请刷新后查看。',
  );
  const eventId = `action:${actor.id}:${id}`;
  const context: PlayerActionContext = {
    raw,
    db,
    actor,
    id,
    now,
    engine,
    prepared,
    flight,
    game,
    eventId,
    matchState,
    keys,
    home,
    edgeUtc,
    playerState,
  };
  const result = dispatchPlayerAction(action, context);
  engine.audit(actor.id, path, actor.id, '玩家操作', {requestId: id});
  db.bump();
  result.revision = db.match().revision;
  return result;
}
