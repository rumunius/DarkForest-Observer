import {type OperationResult} from '@darkforest/contracts';
import {
  integer,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import {permission, requireThat} from '../storage/store';
import {completed} from './engine';
import type {
  JudgeActionContext,
  JudgeMutationContext,
} from './judge_action_context';
import {logEvent} from './life';

/** 按通知版本保存人工复制、发送或失败事实，复制不代表发送。 */
export function recordNoticeStatus(
  context: JudgeActionContext,
  notice: RegExpExecArray,
): OperationResult {
  const {actor, raw, db, now, id, engine, path} = context;
  permission(actor, 'notices');
  strict(raw, ['request_id', 'expected_version', 'reason']);
  const previous = db.one<{status: string; version: number}>(
    'SELECT * FROM notice_queue WHERE id=?',
    notice[1]!,
  );
  requireThat(
    previous &&
      previous.version === integer(raw.expected_version, 1) &&
      previous.status !== 'sent',
    'NOTICE_VERSION_CONFLICT',
    '通知状态已更新，请刷新后查看。',
  );
  const reason = notice[2] === 'error' ? text(raw.reason, 500) : '';
  db.exec(
    'UPDATE notice_queue SET status=?,version=version+1,operator=?,error=? WHERE id=? AND version=?',
    notice[2]!,
    actor.name,
    reason,
    notice[1]!,
    previous.version,
  );
  if (notice[2] === 'copied') {
    db.exec(
      'UPDATE notice_queue SET copied_by=?,copied_utc=? WHERE id=?',
      actor.name,
      now,
      notice[1]!,
    );
  }
  if (notice[2] === 'sent') {
    db.exec(
      'UPDATE notice_queue SET sent_by=?,sent_utc=? WHERE id=?',
      actor.name,
      now,
      notice[1]!,
    );
  }
  const after = db.one<Record<string, SqlStorageValue>>(
    'SELECT * FROM notice_queue WHERE id=?',
    notice[1]!,
  );
  db.exec(
    'INSERT INTO notice_actions VALUES(?,?,?,?,?,?)',
    `${actor.id}:${id}`,
    notice[1]!,
    actor.id,
    notice[2]!,
    now,
    JSON.stringify({before: previous, after, error: reason}),
  );
  engine.audit(actor.id, path, notice[1]!, reason || '通知状态更新', {
    requestId: id,
    status: 'executed',
    before: previous,
    after,
  });
  db.bump();
  return completed(id, '通知状态已更新');
}

/** 登记UTC延时通知，不在提交时提前发布正文。 */
export function scheduleAnnouncement(context: JudgeMutationContext): void {
  const {engine, source, now, raw, actor} = context;
  engine.schedule(
    `${source}:delayed`,
    'judge_delayed_command',
    'utc',
    now + integer(raw.seconds) * 1000,
    3,
    {message: text(raw.message, 1000), actor: actor.id},
  );
}

/** 从当前权威记录计算指定统计并按公开范围发布。 */
export function publishStatistic(context: JudgeMutationContext): void {
  const {raw, db, game, engine, source, now} = context;
  let body: string;
  if (raw.statistic === 'alive_homeworlds') {
    body = `尚存母星共${db.one<{count: number}>("SELECT COUNT(*) AS count FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)")!.count}颗。`;
  } else if (raw.statistic === 'unused_photoids') {
    body = `存活文明持有的未使用光粒共${db.one<{count: number}>("SELECT COALESCE(SUM(p.photons),0) AS count FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND f.status!='eliminated' AND p.id IN (SELECT player_id FROM roster_members)")!.count}枚。`;
  } else {
    body = `过去10分钟成功击毁飞船共${db.one<{count: number}>("SELECT COUNT(*) AS count FROM attacks WHERE classification='hit' AND valid=1 AND game_ms>?", game - 600000)!.count}次。`;
  }
  logEvent(
    engine,
    `${source}:statistic`,
    'notice',
    '赛事统计',
    body,
    'public',
    [],
    game,
    now,
  );
  engine.notice(source, 'group', '赛事统计', body, game);
}

/** 按既有公开事件顺序生成重播待办，不扩大事件可见范围。 */
export function replayPublicEvents(context: JudgeMutationContext): void {
  const {db, raw, engine, source, game} = context;
  const rows = db.all<{
    id: string;
    title: string;
    body: string;
    code: string | null;
  }>(
    "SELECT id,title,body,code FROM event_log WHERE audience='public' ORDER BY seq DESC LIMIT ?",
    integer(raw.count, 1, 10),
  );
  for (const row of rows) {
    engine.notice(
      `${source}:replay:${row.id}`,
      'group',
      `重播：${row.title}`,
      `${row.body}${row.code && !row.body.includes(row.code) ? `\n坐标：${row.code}` : ''}`,
      game,
    );
  }
}

/** 按目标保存赛事事实及QQ待办，个人消息不转为公开消息。 */
export function publishAnnouncement(context: JudgeMutationContext): void {
  const {raw, engine, source, game, now} = context;
  const target = String(raw.target);
  const message = text(raw.message, 1000);
  logEvent(
    engine,
    `${source}:message`,
    'notice',
    '赛事通知',
    message,
    target === '@a' ? 'public' : 'personal',
    target === '@a' ? [] : [target],
    game,
    now,
    target === '@a' ? null : target,
  );
  engine.notice(
    source,
    target === '@a' ? 'group' : target,
    '赛事通知',
    message,
    game,
  );
}
