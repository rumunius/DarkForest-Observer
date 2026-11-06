import {strict, text} from '../../../../packages/contracts/src/backend';
import {requireThat} from '../storage/store';
import {survivors} from './life';

import type {JudgeValidationContext} from './judge_validation_context';

/** 只有已正式开赛且未结束的运行比赛可以暂停。 */
export function validatePause(context: JudgeValidationContext): void {
  const {matchState} = context;

  requireThat(
    matchState.start_settled !== null &&
      matchState.phase !== 'ended' &&
      matchState.paused_at === null,
    'CANNOT_PAUSE',
    '当前不能暂停比赛。',
  );
}

/** 终局资格核验和完赛状态不能通过普通恢复计时绕过。 */
export function validateResume(context: JudgeValidationContext): void {
  const {matchState} = context;

  requireThat(
    matchState.paused_at !== null &&
      matchState.pause_reason !== 'hunt_review' &&
      matchState.phase !== 'ended',
    'CANNOT_RESUME',
    '请先完成终局资格核验。',
  );
}

/** 完整校验终局核验名单，拒绝重复文明或不支持的裁决原因。 */
export function validateHuntFinalization(
  context: JudgeValidationContext,
): void {
  const {engine, matchState, body} = context;

  requireThat(
    matchState.phase === 'hunt' &&
      matchState.paused_at !== null &&
      matchState.pause_reason === 'hunt_review' &&
      matchState.hunt_finalized === null,
    'HUNT_NOT_REVIEWING',
    '当前未进行终局资格核验。',
  );
  requireThat(
    Array.isArray(body.eliminations),
    'BAD_ELIMINATIONS',
    '请核对淘汰名单。',
    400,
  );
  const seen = new Set<string>();
  for (const raw of body.eliminations) {
    const payload = strict(raw, ['id', 'reason']);
    const id = text(payload.id, 16);
    requireThat(
      survivors(engine).includes(id) && !seen.has(id),
      'HUNT_ROSTER_CHANGED',
      '淘汰名单已变化，请重新核对。',
    );
    requireThat(
      ['no_share_at_cutoff', 'outside_at_cutoff'].includes(
        String(payload.reason),
      ),
      'BAD_REASON',
      '请选择裁决原因。',
      400,
    );
    seen.add(id);
  }
}

/** 核对最后狩猎已运行、目标仍存活且违规原因有效。 */
export function validateHuntElimination(context: JudgeValidationContext): void {
  const {engine, matchState, body} = context;

  requireThat(
    matchState.phase === 'hunt' &&
      matchState.hunt_finalized !== null &&
      matchState.paused_at === null,
    'HUNT_NOT_RUNNING',
    '最后狩猎尚未开始。',
  );
  requireThat(
    survivors(engine).includes(text(body.target, 16)),
    'TARGET_NOT_ALIVE',
    '目标已不在存活名单中。',
  );
  requireThat(
    ['left_zone', 'sharing_stopped', 'location_violation'].includes(
      String(body.reason_code),
    ),
    'BAD_REASON',
    '请选择裁决原因。',
    400,
  );
}
