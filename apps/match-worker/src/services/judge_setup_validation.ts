import {
  integer,
  stableJson,
  stringArray,
  text,
} from '../../../../packages/contracts/src/backend';
import {requireThat} from '../storage/store';

import type {JudgeValidationContext} from './judge_validation_context';

/** 核对统一发码或开赛的阶段、UTC范围和逐人就绪状态。 */
export function validateArming(
  context: JudgeValidationContext,
  path: string,
): void {
  const {engine, db, matchState, body} = context;

  requireThat(
    matchState.phase === (path.endsWith('release') ? 'setup' : 'outfitting'),
    'WRONG_PHASE',
    '当前阶段不能安排这个时间。',
  );
  const utc = integer(
    body.time,
    engine.now() + 1000,
    engine.now() + 7 * 86400_000,
  );
  void utc;
  const roster = db.all<{id: string}>(
    "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members) ORDER BY id",
  );
  requireThat(
    Array.isArray(body.expected_roster) &&
      stableJson(stringArray(body.expected_roster).sort()) ===
        stableJson(roster.map(p => p.id)),
    'ROSTER_CHANGED',
    '正式名单已变化，请刷新后重新核对。',
  );
  requireThat(roster.length >= 2, 'ROSTER_TOO_SMALL', '至少需要两名正式玩家。');
  for (const rosterPlayer of roster) {
    const flight = db.flight(rosterPlayer.id);
    const homeworld = db.home(rosterPlayer.id);
    if (path.endsWith('release')) {
      requireThat(
        flight.status === 'staged' &&
          flight.departed !== null &&
          flight.staged !== null &&
          flight.code_id === null &&
          homeworld?.status === 'verified',
        'ROSTER_NOT_READY',
        '仍有正式玩家未完成准备。',
      );
    } else {
      requireThat(
        flight.status === 'ready' &&
          flight.ready !== null &&
          flight.code_id &&
          db.one<Record<string, SqlStorageValue>>(
            "SELECT id FROM sighting_codes WHERE id=? AND player_id=? AND status='reserved'",
            flight.code_id,
            rosterPlayer.id,
          ),
        'ROSTER_NOT_READY',
        '仍有正式玩家未完成穿戴。',
      );
    }
  }
}

/** 核对赛前名单的规模、唯一性与正式参赛资格。 */
export function validateRoster(context: JudgeValidationContext): void {
  const {db, matchState, body} = context;

  requireThat(
    matchState.phase === 'setup',
    'ROSTER_LOCKED',
    '正式参赛名单已锁定。',
  );
  requireThat(
    Array.isArray(body.members) &&
      body.members.length >= 2 &&
      body.members.length <= 350 &&
      new Set(body.members).size === body.members.length,
    'BAD_ROSTER',
    '请选择至少两名正式玩家，每个账号只选一次。',
    400,
  );
  for (const id of body.members) {
    requireThat(
      db.player(text(id, 16)).entry_status === 'registered',
      'NOT_REGISTERED',
      '退出正式名单的账号不能加入本场。',
    );
  }
}

/** 核对首航名单尚可调整且文明仍正式参赛。 */
export function validateWithdrawal(
  context: JudgeValidationContext,
  path: string,
): void {
  const {db, matchState} = context;

  requireThat(
    ['setup', 'armed', 'outfitting'].includes(matchState.phase),
    'ROSTER_LOCKED',
    '当前不能调整首航名单。',
  );
  const id = path.split('/')[3]!;
  requireThat(
    db.player(id).entry_status === 'registered',
    'NOT_REGISTERED',
    '该文明已退出正式名单。',
  );
}
