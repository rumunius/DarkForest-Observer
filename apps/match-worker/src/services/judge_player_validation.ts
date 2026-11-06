import {
  integer,
  nickname,
  text,
} from '../../../../packages/contracts/src/backend';
import {requireThat} from '../storage/store';
import {survivors} from './life';
import {restoration} from './player_correction';

import type {JudgeValidationContext} from './judge_validation_context';
/** 只允许在正式比赛中淘汰当前存活文明。 */
export function validatePlayerElimination(
  context: JudgeValidationContext,
): void {
  const {engine, matchState, body} = context;

  requireThat(
    matchState.start_settled !== null && matchState.phase !== 'ended',
    'MATCH_NOT_RUNNING',
    '请在比赛正式开始后记录违规淘汰。',
  );
  requireThat(
    survivors(engine).includes(text(body.target, 16)),
    'TARGET_NOT_ALIVE',
    '目标已不在存活名单中。',
  );
}

/** 核对可撤销效果或新增限制的目标及UTC时长。 */
export function validateEffect(context: JudgeValidationContext): void {
  const {db, body} = context;

  if (body.revoke) {
    requireThat(
      db.one<Record<string, SqlStorageValue>>(
        'SELECT id FROM admin_effects WHERE id=? AND active=1',
        text(body.revoke, 100),
      ),
      'EFFECT_NOT_ACTIVE',
      '该临时效果已经结束。',
    );
  } else {
    const target = text(body.target, 16);
    requireThat(
      target === '@a' ||
        !!db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM players WHERE id=?',
          target,
        ),
      'PLAYER_NOT_FOUND',
      '文明不存在。',
      404,
    );
    integer(body.seconds, 1, 86400);
  }
}

/** 核对设备处理方式、暂停门禁及当前航次状态。 */
export function validateEquipmentCorrection(
  context: JudgeValidationContext,
): void {
  const {db, matchState, body} = context;

  const target = text(body.target, 16);
  db.player(target);
  requireThat(
    (body.mode === 'replace' || matchState.paused_at !== null) &&
      matchState.phase !== 'ended',
    'PAUSE_REQUIRED',
    '请先暂停比赛。',
  );
  requireThat(
    ['replace', 'reissue', 'activate'].includes(String(body.mode)),
    'BAD_MODE',
    '处理方式不正确。',
    400,
  );
  requireThat(
    db.flight(target).status ===
      (body.mode === 'activate' ? 'issued' : 'active') ||
      (matchState.recovery_state.startsWith('review:') &&
        body.mode === 'reissue' &&
        ['issued', 'outfitting', 'ready'].includes(db.flight(target).status)),
    'FLIGHT_STATE_CONFLICT',
    '请重新核对当前航次。',
  );
}

/** 核对可更正项目及其昵称、资源或恢复资格约束。 */
export function validatePlayerCorrection(
  context: JudgeValidationContext,
): void {
  const {engine, db, matchState, body} = context;

  db.player(text(body.target, 16));
  requireThat(
    matchState.phase !== 'ended',
    'RESULTS_SEALED',
    '比赛已结束，请通过赛后更正处理。',
  );
  const field = text(body.field, 20);
  requireThat(
    ['nickname', 'photons', 'broadcasts', 'restore'].includes(field),
    'BAD_FIELD',
    '更正项目不正确。',
    400,
  );
  if (field === 'nickname') {
    const n = nickname(body.value);
    requireThat(
      !db.one<Record<string, SqlStorageValue>>(
        'SELECT id FROM players WHERE nickname=? AND id<>?',
        n,
        String(body.target),
      ),
      'NICKNAME_TAKEN',
      '这个昵称已被使用。',
    );
  } else if (field === 'restore') {
    restoration(engine, String(body.target));
  } else {
    integer(Number(body.value), 0, field === 'photons' ? 1 : 2);
  }
}

/** 核对文明存在及观战管理开关的实际布尔类型。 */
export function validateObserverAccess(context: JudgeValidationContext): void {
  const {db, body} = context;

  db.player(text(body.target, 16));
  requireThat(
    typeof body.allowed === 'boolean',
    'BAD_ACCESS',
    '观战权限设置不正确。',
    400,
  );
}
