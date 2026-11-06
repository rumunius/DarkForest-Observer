import {
  coordinate,
  integer,
  text,
} from '../../../../packages/contracts/src/backend';
import {TIMES} from '../domain/rules';
import {dueUtc} from '../scheduler/events';
import type {Scheduled} from '../storage/store';
import {requireThat} from '../storage/store';

import type {JudgeValidationContext} from './judge_validation_context';

/** 核对公告受众及消息正文长度。 */
export function validateAnnouncement(context: JudgeValidationContext): void {
  const {db, body} = context;

  const target = text(body.target, 16);
  if (target !== '@a') {
    db.player(target);
  }
  text(body.message, 1000);
}

/** 核对原事件的取消或重试资格，禁止提前结算或重开已取消事件。 */
export function validateEventControl(context: JudgeValidationContext): void {
  const {engine, db, matchState, body} = context;

  const event = db.one<Scheduled>(
    'SELECT * FROM scheduled_events WHERE id=?',
    text(body.event_id, 180),
  );
  requireThat(event, 'EVENT_NOT_FOUND', '赛事事件不存在。', 404);
  requireThat(
    body.operation === 'retry' || body.operation === 'cancel',
    'BAD_OPERATION',
    '请选择处理方式。',
    400,
  );
  if (body.operation === 'cancel') {
    requireThat(
      matchState.paused_at !== null &&
        event.status === 'pending' &&
        ['song_visit', 'tech_burst', 'judge_delayed_command'].includes(
          event.kind,
        ),
      'EVENT_NOT_CANCELLABLE',
      '请暂停比赛后核对该事件。',
    );
  } else {
    requireThat(
      !matchState.recovery_state,
      'RECOVERY_REVIEW',
      '请先完成比赛恢复核对，再重试赛事事件。',
    );
    requireThat(
      event.status !== 'cancelled',
      'EVENT_CANCELLED',
      '已取消事件不能重开；需要新增事件时请使用独立的手动触发操作。',
    );
    const utc = dueUtc(engine, event);
    requireThat(
      event.status === 'settled' || (utc !== null && utc <= engine.now()),
      'EVENT_NOT_DUE',
      '该计划尚未到期，不能提前执行。',
    );
  }
}

/** 只允许第一阶段暂停期间手动触发合法歌者坐标。 */
export function validateEventTrigger(context: JudgeValidationContext): void {
  const {engine, matchState, body} = context;

  requireThat(
    matchState.paused_at !== null &&
      matchState.phase === 'forest' &&
      engine.game() < TIMES.apocalypse,
    'PAUSE_REQUIRED',
    '请在第一阶段暂停后核对手动事件。',
  );
  requireThat(
    body.kind === 'song_visit',
    'BAD_EVENT_KIND',
    '当前手动事件仅支持歌者清理。',
    400,
  );
  coordinate(body.code);
}

/** 校验延迟公告的UTC秒数及消息正文。 */
export function validateDelayedAnnouncement(
  context: JudgeValidationContext,
): void {
  const {body} = context;

  integer(body.seconds, 1, 86400);
  text(body.message, 1000);
}

/** 只允许公开明确支持的实时统计项目。 */
export function validateStatistic(context: JudgeValidationContext): void {
  const {body} = context;

  requireThat(
    ['alive_homeworlds', 'unused_photoids', 'kills_last_10min'].includes(
      String(body.statistic),
    ),
    'BAD_STATISTIC',
    '请选择统计项目。',
    400,
  );
}

/** 限制一次重播的公开事件数量。 */
export function validateReplay(context: JudgeValidationContext): void {
  const {body} = context;

  integer(body.count, 1, 10);
}
